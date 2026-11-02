/**
 * ISOLATED E2E for the phone arrangement of session views: the real Electron
 * app (acceptance build, fresh temp run root) serves the phone client on the
 * mock-mode remote port, and a WebKit phone page (390x844, touch) drives it.
 *
 * Proves: side views read as tabs beside Chat, bottom-dock views share a
 * bottom sheet, transient cards float above the composer, slot cards render
 * inside the message, and long-pressing a tab moves the view (the desktop
 * layout report sees the move). Views open full screen in one tap (swipe down,
 * Done, or Esc closes them) and the sheet's grabber drags between its stops.
 *
 * Run:
 *   MARSHAL_RUNTIME_ACCEPTANCE_BUILD=1 pnpm build:vite
 *   RUNROOT=/private/tmp/session-phone-run; rm -rf $RUNROOT; mkdir -p $RUNROOT/temp
 *   TMPDIR=$RUNROOT/temp MARSHAL_PLACEMENT_RUN_ROOT=$RUNROOT \
 *     pnpm test:e2e:file e2e/session-phone-views.marshal.test.ts
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test, webkit, type Locator, type Page } from "@playwright/test";

import {
  acceptanceWorkspaceRoot,
  AUTHORED_OWNER,
  cardRenderer,
  grantPortableUi,
  invokeCapability,
  layoutViews,
  pick,
  requireBox,
  requireRunRoot,
  seedSlotConversation,
  text,
} from "./helpers/session-views";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";

const RUN_ROOT = requireRunRoot();
const evidenceDir = path.join(RUN_ROOT, "phone-evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const evidence: Record<string, unknown>[] = [];

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
}

/** A finger drag as pointer events; the page sees one touch pointer move in four steps. */
async function touchDrag(target: Locator, dy: number) {
  const box = await requireBox(target);
  const at = (step: number) => ({
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2 + dy * step,
    pointerType: "touch",
    pointerId: 7,
    isPrimary: true,
  });
  await target.dispatchEvent("pointerdown", at(0));
  for (const step of [0.25, 0.5, 0.75, 1]) {
    // eslint-disable-next-line no-await-in-loop -- the moves must arrive in order
    await target.dispatchEvent("pointermove", at(step));
  }
  await target.dispatchEvent("pointerup", at(1));
}

async function enableRemoteAccess(page: Page): Promise<string> {
  const state: unknown = await page.evaluate(async () => {
    const api: unknown = Reflect.get(window, "remoteAccessAPI");
    const configure: unknown = api ? Reflect.get(api as object, "configure") : undefined;
    if (typeof configure !== "function") throw new Error("remoteAccessAPI unavailable");
    return (await Reflect.apply(configure, api, [{ enabled: true, origin: "" }])) as unknown;
  });
  expect(pick(state, "running"), JSON.stringify(pick(state, "error"))).toBe(true);
  return text(pick(state, "accessKey"));
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test("phone shows session views as tabs, a bottom sheet, and floating transient cards", async () => {
  seedTestData();
  grantPortableUi();
  seedSlotConversation();
  const app = await launchPersistentE2EApp({
    userDataDir: path.join(RUN_ROOT, "user-data"),
    seed: false,
    extraEnv: {
      MARSHAL_RUNTIME_ACCEPTANCE: "1",
      MARSHAL_RUNTIME_ACCEPTANCE_TOKEN: randomBytes(16).toString("hex"),
      MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: RUN_ROOT,
    },
  });
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("session-dock")).toBeVisible({ timeout: 60_000 });
    const invoke = (capability: string, input: unknown, key: string) =>
      invokeCapability(page, capability, input, key, evidence);

    const workspaceRoot = await acceptanceWorkspaceRoot(page);
    const docA = path.join(workspaceRoot, "phone-alpha.md");
    const docB = path.join(workspaceRoot, "phone-beta.md");
    fs.writeFileSync(docA, "# Alpha\n\nA side view.\n");
    fs.writeFileSync(docB, "# Beta\n\nA bottom view.\n");
    const alpha = await invoke(
      "ui.document.open",
      { path: docA, idempotencyKey: "open-a" },
      "open-a",
    );
    const beta = await invoke(
      "ui.document.open",
      { path: docB, idempotencyKey: "open-b" },
      "open-b",
    );
    const alphaId = text(pick(alpha, "instance", "instanceId"));
    const betaId = text(pick(beta, "instance", "instanceId"));
    expect(alphaId).not.toBe("");
    await invoke("ui.view.move", { instanceId: betaId, placement: "bottom" }, "move-b");

    const render = await cardRenderer(page, evidence);
    await invoke(
      "ui.application.open",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: await render("phone-slot"),
        placement: "card",
        title: "Slot card",
        slot: "demo",
        idempotencyKey: "open-slot",
      },
      "open-slot",
    );
    await invoke(
      "ui.chat.card.show",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: await render("phone-transient"),
        title: "Sign in",
        idempotencyKey: "show-transient",
      },
      "show-transient",
    );

    // Desktop: one click opens a chat card full screen and Esc returns it.
    const slotCard = page.getByTestId("runtime-ui-card").filter({ hasText: "Slot card" });
    const desktopExpanded = page.getByTestId("runtime-ui-expanded");
    await expect(slotCard).toBeVisible({ timeout: 30_000 });
    // The card can re-render while the session loads; retry a click that landed mid-mount.
    await expect(async () => {
      await slotCard.getByTestId("runtime-ui-expand").click();
      await expect(desktopExpanded).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(slotCard.getByTestId("runtime-ui-expanded-placeholder")).toBeVisible();
    await desktopExpanded.evaluate((element) =>
      Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    await shot(page, "00-desktop-card-expanded");
    await page.keyboard.press("Escape");
    await expect(desktopExpanded).toHaveCount(0);

    const accessKey = await enableRemoteAccess(page);
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    phone.on("pageerror", (error) => evidence.push({ phoneerror: String(error).slice(0, 800) }));
    await phone.addInitScript(() => localStorage.setItem("marshal.remote.session", "e2e-fresh"));
    await phone.goto(`http://127.0.0.1:7332/#key=${encodeURIComponent(accessKey)}`);

    const tabs = phone.getByTestId("mobile-session-tab");
    await expect(tabs.filter({ hasText: "Chat" })).toHaveCount(1, { timeout: 60_000 });
    await expect(tabs.filter({ hasText: "phone-alpha.md" })).toHaveCount(1);
    const sheet = phone.getByTestId("mobile-bottom-sheet");
    await expect(sheet.getByText("phone-beta.md")).toBeVisible();
    await expect(
      phone.getByTestId("runtime-ui-transient-cards").getByText("Sign in"),
    ).toBeVisible();
    await expect(phone.locator('[data-ui-slot="demo"]').getByText("Slot card")).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await shot(phone, "01-phone-chat");

    // The desktop-only slot card offers a phone-view request; it must pass the remote policy.
    const slotGate = phone.locator('[data-ui-slot="demo"]').getByTestId("runtime-ui-viewport-gate");
    await slotGate.getByRole("button", { name: /ask for a phone view/i }).tap();
    await expect(slotGate.getByText(/asked the session.s agent/i)).toBeVisible();
    await expect(slotGate.getByText(/could not be sent/i)).toHaveCount(0);

    await phone
      .getByTestId("runtime-ui-transient-cards")
      .getByTestId("runtime-ui-card-close")
      .tap();
    await expect(phone.getByTestId("runtime-ui-transient-cards")).toHaveCount(0);
    await expect(sheet).toHaveAttribute("data-expanded", "false");
    await sheet.getByTestId("mobile-sheet-tab").filter({ hasText: "phone-beta.md" }).tap();
    await expect(sheet).toHaveAttribute("data-expanded", "true");
    await shot(phone, "02-phone-sheet-expanded");

    // The iPhone keyboard shrinks the visible area; installRemoteViewport reports it like this.
    const keyboard = (open: boolean) =>
      phone.evaluate((isOpen) => {
        const root = document.documentElement;
        root.toggleAttribute("data-keyboard", isOpen);
        root.style.setProperty("--remote-height", isOpen ? "400px" : `${window.innerHeight}px`);
      }, open);
    await keyboard(true);
    const composer = await requireBox(phone.getByTestId("chat-input-editor"));
    const folded = await requireBox(sheet);
    evidence.push({ keyboard: { composer, sheet: folded } });
    expect(composer.y + composer.height).toBeLessThanOrEqual(400);
    expect(folded.height).toBeLessThanOrEqual(72);
    await shot(phone, "02b-phone-keyboard-open");
    await keyboard(false);
    await expect.poll(async () => (await requireBox(sheet)).height).toBeGreaterThan(200);

    // The grabber drags the sheet between its stops: half, then nearly full, then back.
    const grabber = phone.getByTestId("mobile-bottom-sheet-grabber");
    await expect(sheet).toHaveAttribute("data-detent", "half");
    await touchDrag(grabber, -300);
    await expect(sheet).toHaveAttribute("data-detent", "full");
    await expect.poll(async () => (await requireBox(sheet)).height).toBeGreaterThan(650);
    await shot(phone, "02c-phone-sheet-full");
    await touchDrag(grabber, 300);
    await expect(sheet).toHaveAttribute("data-detent", "half");

    // The sheet's view opens full screen in one tap; Done returns it.
    const expandedView = phone.getByTestId("runtime-ui-expanded");
    await sheet.getByTestId("runtime-ui-expand").tap();
    await expect(expandedView).toBeVisible();
    await expect(sheet.getByTestId("runtime-ui-expanded-placeholder")).toBeVisible();
    await phone.getByTestId("runtime-ui-expanded-done").tap();
    await expect(expandedView).toHaveCount(0);
    await phone.getByTestId("mobile-bottom-sheet-toggle").tap();
    await expect(sheet).toHaveAttribute("data-expanded", "false");

    const alphaTab = tabs.filter({ hasText: "phone-alpha.md" });
    await alphaTab.tap();
    await expect(phone.getByTestId("mobile-session-view")).toBeVisible();
    await shot(phone, "03-phone-alpha-tab");

    // One tap opens the tab full screen, iOS style; a swipe down on its header dismisses it.
    await phone.getByRole("tablist").getByTestId("runtime-ui-expand").tap();
    await expect(expandedView).toBeVisible();
    // Measured once the slide-up animation settles.
    const expandedSheet = expandedView.locator("section");
    await expandedView.evaluate((element) =>
      Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    const fullScreen = await requireBox(expandedSheet);
    evidence.push({
      expanded: fullScreen,
      styles: await expandedSheet.evaluate((element) => {
        const style = getComputedStyle(element);
        const overlay = element.parentElement?.getBoundingClientRect();
        return {
          transform: style.transform,
          width: style.width,
          maxWidth: style.maxWidth,
          margin: style.margin,
          overlay: overlay && [overlay.x, overlay.y, overlay.width, overlay.height],
          body: document.body.getBoundingClientRect().width,
          innerWidth: window.innerWidth,
          clientWidth: document.documentElement.clientWidth,
          visualWidth: window.visualViewport?.width,
        };
      }),
    });
    // Full screen means the whole area the phone app itself occupies.
    const appFrame = await requireBox(phone.locator("#root"));
    evidence.push({ appFrame });
    expect(fullScreen).toEqual(appFrame);
    await expect(expandedView.getByText("phone-alpha.md")).toBeVisible();
    await shot(phone, "03b-phone-alpha-full-screen");
    await touchDrag(phone.getByTestId("runtime-ui-expanded-header"), 220);
    await expect(expandedView).toHaveCount(0);
    await expect(phone.getByTestId("mobile-session-view")).toBeVisible();

    // Long-press the tab and move the view into the bottom sheet.
    const box = await requireBox(alphaTab);
    const point = {
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
      pointerType: "touch",
      isPrimary: true,
    };
    const menu = phone.getByTestId("mobile-move-menu");
    await alphaTab.dispatchEvent("pointerdown", point);
    await expect(menu).toBeVisible();
    await alphaTab.dispatchEvent("pointerup", point);
    await shot(phone, "04-phone-move-menu");
    await menu.getByText("Bottom sheet").tap();
    await expect(sheet.getByText("phone-alpha.md")).toBeVisible();
    await expect(tabs.filter({ hasText: "phone-alpha.md" })).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await layoutViews(page)).find((view) => view.instanceId === alphaId)?.placement,
      )
      .toBe("bottom");
    await shot(phone, "05-phone-alpha-in-sheet");
  } finally {
    fs.writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
    await browser.close();
    await app.close();
  }
});
