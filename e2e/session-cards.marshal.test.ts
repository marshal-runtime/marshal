/**
 * ISOLATED E2E for conversation cards: real Electron app in an
 * acceptance-enabled E2E build with a fresh temp userData/run root.
 *
 * The seeded session holds a user message and an assistant reply containing
 * a `<!--ui:demo-->` slot. The test compiles a real authored component and
 * proves: a permanent card trails the conversation, a card anchored with
 * afterMessageId sits after that message, a slot-bound card renders inside
 * the assistant message and a fixed render replaces it in place, transient
 * cards float above the chat and leave on timeout or close, and permanent
 * cards survive a renderer reload.
 *
 * Run:
 *   MARSHAL_RUNTIME_ACCEPTANCE_BUILD=1 pnpm build:vite
 *   RUNROOT=/private/tmp/session-cards-run; rm -rf $RUNROOT; mkdir -p $RUNROOT/temp
 *   TMPDIR=$RUNROOT/temp MARSHAL_PLACEMENT_RUN_ROOT=$RUNROOT \
 *     pnpm test:e2e:file e2e/session-cards.marshal.test.ts
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  AUTHORED_OWNER,
  cardRenderer,
  grantPortableUi,
  invokeCapability,
  pick,
  requireRunRoot,
  seedSlotConversation,
  text,
} from "./helpers/session-views";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";

const RUN_ROOT = requireRunRoot();
const evidenceDir = path.join(RUN_ROOT, "cards-evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const evidence: Record<string, unknown>[] = [];

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
}

/** True when a timeline row starts above the end of the row before it (a card grew a row that was not re-measured). */
function rowsOverlap(page: Page): Promise<boolean> {
  return page.getByTestId("timeline-virtual-row").evaluateAll((rows) => {
    const boxes = rows.map((row) => row.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    return boxes.some((box, index) => index > 0 && box.top < boxes[index - 1].bottom - 1);
  });
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test("permanent, anchored, slot and transient cards render in their places", async () => {
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
    page.on("console", (message) => {
      if (message.type() === "error") evidence.push({ console: message.text().slice(0, 800) });
    });
    page.on("pageerror", (error) => evidence.push({ pageerror: String(error).slice(0, 800) }));
    await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);
    await expect(page.getByTestId("session-dock")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("It updates in place.")).toBeVisible({ timeout: 30_000 });

    const invoke = (capability: string, input: unknown, key: string) =>
      invokeCapability(page, capability, input, key, evidence);
    const render = await cardRenderer(page, evidence);
    const trailingId = await render("trailing-card");
    const anchoredId = await render("anchored-card");
    const slotId = await render("slot-card");
    const expiringId = await render("expiring-card");
    const closableId = await render("closable-card");
    const completingId = await render("completing-card");

    const cardTitled = (title: string) =>
      page.getByTestId("runtime-ui-card").filter({ has: page.getByText(title, { exact: true }) });

    await invoke(
      "ui.application.open",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: trailingId,
        placement: "card",
        title: "Trailing card",
        idempotencyKey: "open-trailing",
      },
      "open-trailing",
    );
    await expect(
      page.getByTestId("runtime-ui-trailing-cards").getByText("Trailing card"),
    ).toBeVisible();

    await invoke(
      "ui.application.open",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: anchoredId,
        placement: "card",
        title: "Anchored card",
        afterMessageId: "seed-user-1",
        idempotencyKey: "open-anchored",
      },
      "open-anchored",
    );
    await expect(
      page.getByTestId("runtime-ui-message-cards").getByText("Anchored card"),
    ).toBeVisible();
    await expect.poll(() => rowsOverlap(page)).toBe(false);

    const slotOpened = await invoke(
      "ui.application.open",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: slotId,
        placement: "card",
        title: "Slot card",
        slot: "demo",
        idempotencyKey: "open-slot",
      },
      "open-slot",
    );
    const slotInstanceId = text(pick(slotOpened, "instance", "instanceId"));
    expect(slotInstanceId).not.toBe("");
    const slot = page.locator('[data-ui-slot="demo"]');
    await expect(slot.getByText("Slot card")).toBeVisible();
    await expect(
      page.getByTestId("message-assistant").locator('[data-ui-slot="demo"]'),
    ).toHaveCount(1);
    await expect(page.getByTestId("runtime-ui-trailing-cards").getByText("Slot card")).toHaveCount(
      0,
    );
    await shot(page, "01-permanent-anchored-slot");

    // A fixed render replaces the slot's view in place: same id, same slot.
    const slotFixedId = await render("slot-card-fixed");
    const replaced = await invoke(
      "ui.application.open",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: slotFixedId,
        placement: "card",
        title: "Slot card fixed",
        slot: "demo",
        replaceInstanceId: slotInstanceId,
        idempotencyKey: "open-slot-fixed",
      },
      "open-slot-fixed",
    );
    expect(pick(replaced, "instance", "instanceId")).toBe(slotInstanceId);
    await expect(slot.getByText("Slot card fixed")).toBeVisible();
    await expect(slot.getByTestId("runtime-ui-card")).toHaveCount(1);
    await expect(page.getByText("Slot card", { exact: true })).toHaveCount(0);
    await expect.poll(() => rowsOverlap(page)).toBe(false);

    await invoke(
      "ui.chat.card.show",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: expiringId,
        title: "Sign in",
        timeoutMs: 4_000,
        idempotencyKey: "show-expiring",
      },
      "show-expiring",
    );
    await invoke(
      "ui.chat.card.show",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: closableId,
        title: "API key",
        idempotencyKey: "show-closable",
      },
      "show-closable",
    );
    const transient = page.getByTestId("runtime-ui-transient-cards");
    await expect(transient.getByText("Sign in")).toBeVisible();
    await expect(transient.getByText("API key")).toBeVisible();
    await expect(page.getByTestId("message-assistant").getByText("API key")).toHaveCount(0);
    await shot(page, "02-transient-cards");

    // Let the timed card expire first so the stack does not reflow under the × click.
    await expect(transient.getByText("Sign in")).toHaveCount(0, { timeout: 15_000 });
    await expect(transient.getByText("API key")).toBeVisible();
    await cardTitled("API key").getByTestId("runtime-ui-card-close").click();
    await expect(transient.getByText("API key")).toHaveCount(0);

    // The owner closes a transient card once its flow completes.
    const tokenShown = await invoke(
      "ui.chat.card.show",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: completingId,
        title: "Token",
        idempotencyKey: "show-completing",
      },
      "show-completing",
    );
    await expect(transient.getByText("Token")).toBeVisible();
    await invoke(
      "ui.application.close",
      {
        extensionId: AUTHORED_OWNER,
        applicationId: completingId,
        instanceId: text(pick(tokenShown, "instance", "instanceId")),
        idempotencyKey: "close-completing",
      },
      "close-completing",
    );
    await expect(transient.getByText("Token")).toHaveCount(0);
    await shot(page, "03-transient-gone");

    await page.reload();
    await expect(page.getByTestId("session-dock")).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByTestId("runtime-ui-trailing-cards").getByText("Trailing card"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("runtime-ui-message-cards").getByText("Anchored card"),
    ).toBeVisible();
    await expect.poll(() => rowsOverlap(page)).toBe(false);
    await expect(page.locator('[data-ui-slot="demo"]').getByText("Slot card fixed")).toBeVisible();
    await expect(page.getByTestId("runtime-ui-transient-cards")).toHaveCount(0);
    await shot(page, "04-after-reload");
  } finally {
    fs.writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
    await app.close();
  }
});
