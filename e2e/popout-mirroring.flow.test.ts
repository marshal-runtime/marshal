/**
 * Cross-window mirroring.
 *
 * Pins the production behaviour the unit tests can't reach: a user message
 * sent in one window must render live in every other window viewing the
 * same session. The unit tests confirm the broadcast emits; only an e2e
 * with two real BrowserWindows confirms it reaches the peer.
 */
import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

test("user message sent in the main window mirrors live to an open popout — Marshal flow", async ({
  app,
  page,
}) => {
  await chatInput(page).waitFor();

  // Drive the real user flow: select the session, hover to reveal the
  // overflow button, open the menu, click "Open in New Window".
  // Locate by accessible role + name so the test reflects what the user
  // actually sees, not the internal data-testid.
  const sessionRow = page.getByRole("button", { name: /API design review/ });
  await sessionRow.click();
  await chatInput(page).waitFor();
  await sessionRow.hover();

  const popoutOpened = app.waitForEvent("window");
  await sessionRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Open in New Window/ }).click();
  const popout = await popoutOpened;
  await popout.waitForLoadState("domcontentloaded");
  await chatInput(popout).waitFor();

  // Send a unique message from the main window. The marker doesn't appear
  // in any seeded data, so the assertion can't pass coincidentally.
  const marker = `MIRROR_TEST_${Date.now()}`;
  await chatInput(page).fill(marker);
  await chatInput(page).press("Enter");

  // Wait for the input to clear before checking either window — that's
  // the user-visible signal that the send mutation actually ran. Without
  // this, the assertions could race past an in-flight optimistic update.
  await expect(chatInput(page)).toHaveText("");

  // The mirroring guarantee: the same user message is visible in both
  // windows. Asserted by user-visible text — that's the actual contract
  // the feature promises.
  await expect(page.getByText(marker)).toBeVisible();
  await expect(popout.getByText(marker)).toBeVisible({ timeout: 5000 });

  // Reverse direction: typing in the popout must mirror back to the main
  // window. The two directions exercise different preload/window-context
  // wiring — the popout sends via its own renderer's `copilotAPI`, which
  // could regress independently of the main → popout path.
  const reverseMarker = `MIRROR_REVERSE_${Date.now()}`;
  await chatInput(popout).fill(reverseMarker);
  await chatInput(popout).press("Enter");
  await expect(chatInput(popout)).toHaveText("");
  await expect(popout.getByText(reverseMarker)).toBeVisible();
  await expect(page.getByText(reverseMarker)).toBeVisible({ timeout: 5000 });
});
