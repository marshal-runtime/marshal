/**
 * ISOLATED E2E for opening a view before the reply that places it: real
 * Electron app in an acceptance-enabled E2E build with a fresh temp run root.
 *
 * The `slot-reply` mock turn runs one tool call, then streams a reply with a
 * `<!--ui:reply-->` marker between two paragraphs. The test opens a slot card
 * during the tool call and proves it never shows between messages, appears
 * inside the reply once the marker streams, stays there after the turn
 * commits and after a reload, and that a slot card whose marker never comes
 * still falls back to the timeline once the turn is over.
 *
 * Run:
 *   MARSHAL_RUNTIME_ACCEPTANCE_BUILD=1 pnpm build:vite
 *   RUNROOT=/private/tmp/slot-reply-run; rm -rf $RUNROOT; mkdir -p $RUNROOT/temp
 *   TMPDIR=$RUNROOT/temp MARSHAL_PLACEMENT_RUN_ROOT=$RUNROOT \
 *     pnpm test:e2e:file e2e/session-slot-reply.marshal.test.ts
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { chatInput } from "./helpers/marshal-chat-input";
import {
  AUTHORED_OWNER,
  cardRenderer,
  grantPortableUi,
  invokeCapability,
  requireRunRoot,
  seedSlotConversation,
} from "./helpers/session-views";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";

const RUN_ROOT = requireRunRoot();
const evidenceDir = path.join(RUN_ROOT, "slot-reply-evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const evidence: Record<string, unknown>[] = [];

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
}

/** Records every moment a card titled `title` renders outside a message slot. */
function watchForStrayCard(page: Page, title: string): Promise<void> {
  return page.evaluate((cardTitle) => {
    const sightings: string[] = [];
    Reflect.set(window, "__straySightings", sightings);
    window.setInterval(() => {
      for (const card of document.querySelectorAll('[data-testid="runtime-ui-card"]')) {
        if (!card.textContent?.includes(cardTitle)) continue;
        if (card.closest("[data-ui-slot]")) continue;
        const list = card.closest("[data-testid]")?.getAttribute("data-testid") ?? "unknown";
        sightings.push(`${new Date().toISOString()} ${list}`);
      }
    }, 25);
  }, title);
}

function straySightings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sightings: unknown = Reflect.get(window, "__straySightings");
    return Array.isArray(sightings) ? sightings.map(String) : [];
  });
}

test.setTimeout(300_000);

test("a view opened before the reply renders inside the reply's slot", async () => {
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
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => evidence.push({ pageerror: String(error).slice(0, 800) }));
    await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);
    await expect(page.getByTestId("session-dock")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("It updates in place.")).toBeVisible({ timeout: 30_000 });

    const render = await cardRenderer(page, evidence);
    const replyId = await render("reply-card");
    const orphanId = await render("orphan-card");
    await watchForStrayCard(page, "Reply card");

    const input = chatInput(page);
    await input.fill("slot-reply");
    await input.press("Enter");
    await expect(page.getByTestId("message-user").filter({ hasText: "slot-reply" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByTestId("working-spinner").or(page.getByTestId("message-tools-block")).first(),
    ).toBeVisible({
      timeout: 15_000,
    });

    await invokeCapability(
      page,
      "ui.application.open",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: replyId,
        placement: "card",
        title: "Reply card",
        slot: "reply",
        idempotencyKey: "open-reply",
      },
      "open-reply",
      evidence,
    );
    // A misplaced card would appear within a render or two; give it time to show.
    await page.waitForTimeout(1_500); // eslint-disable-line playwright/no-wait-for-timeout
    await expect(page.getByText("Here is the view you asked for:")).toHaveCount(0);
    await expect(page.getByTestId("runtime-ui-card").filter({ hasText: "Reply card" })).toHaveCount(
      0,
    );
    await shot(page, "01-view-open-before-reply");

    const replySlot = page
      .getByTestId("message-assistant")
      .locator('[data-ui-slot="reply"]')
      .getByText("Reply card");
    await expect(replySlot).toBeVisible({ timeout: 30_000 });
    await shot(page, "02-marker-streamed");

    await expect(page.getByText("It sits inside this reply.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("working-spinner")).toHaveCount(0, { timeout: 30_000 });
    // Let the commit settle so the stray-card watcher covers the handoff from the live turn.
    await page.waitForTimeout(1_500); // eslint-disable-line playwright/no-wait-for-timeout
    const reply = page
      .getByTestId("message-assistant")
      .filter({ hasText: "Here is the view you asked for:" });
    await expect(reply).toHaveCount(1);
    await expect(reply.locator('[data-ui-slot="reply"]').getByText("Reply card")).toBeVisible();
    const order = await reply.evaluate((message) => {
      const top = (node: Element | null | undefined) => node?.getBoundingClientRect().top ?? -1;
      const paragraphs = [...message.querySelectorAll("p")];
      return {
        intro: top(paragraphs.find((node) => node.textContent?.includes("Here is the view"))),
        slot: top(message.querySelector('[data-ui-slot="reply"]')),
        outro: top(paragraphs.find((node) => node.textContent?.includes("It sits inside"))),
      };
    });
    evidence.push({ order });
    expect(order.intro).toBeGreaterThanOrEqual(0);
    expect(order.slot).toBeGreaterThan(order.intro);
    expect(order.outro).toBeGreaterThan(order.slot);
    await shot(page, "03-committed-inline");

    const sightings = await straySightings(page);
    evidence.push({ sightings });
    expect(sightings, "reply card never shows outside its slot").toEqual([]);

    await invokeCapability(
      page,
      "ui.application.open",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: orphanId,
        placement: "card",
        title: "Orphan card",
        slot: "never-written",
        idempotencyKey: "open-orphan",
      },
      "open-orphan",
      evidence,
    );
    await expect(
      page.getByTestId("runtime-ui-trailing-cards").getByText("Orphan card"),
    ).toBeVisible({ timeout: 15_000 });
    await shot(page, "04-orphan-falls-back");

    await page.reload();
    await expect(page.getByTestId("session-dock")).toBeVisible({ timeout: 60_000 });
    await expect(
      page
        .getByTestId("message-assistant")
        .filter({ hasText: "Here is the view you asked for:" })
        .locator('[data-ui-slot="reply"]')
        .getByText("Reply card"),
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, "05-after-reload");
  } finally {
    fs.writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
    await app.close();
  }
});
