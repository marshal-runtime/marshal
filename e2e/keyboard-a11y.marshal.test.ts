import { sharedTest as test, expect } from "./marshal-fixtures";

test.describe("Keyboard accessibility", () => {
  test("nav has semantic landmarks and keyboard navigation", async ({ page }) => {
    const nav = page.locator("nav[aria-label='Main navigation']");
    await expect(nav).toBeVisible();

    // Section heading — "Chats" is the search input placeholder (the standalone Settings h3 is gone;
    // Settings now lives as an icon button in the bottom bar)
    await expect(nav.getByRole("textbox", { name: "Search chats" })).toBeVisible();

    // Header is a <header> element
    await expect(page.locator("header")).toBeVisible();

    // Tab order: New chat is the first focusable item in the nav
    const newChatBtn = nav.locator('[data-testid="new-chat-btn"]');
    await newChatBtn.focus();
    await expect(newChatBtn).toBeFocused();

    // Tab: New chat → next top-nav item (Automations)
    await page.keyboard.press("Tab");
    await expect(nav.getByRole("button", { name: "Automations" })).toBeFocused();

    // Search input and first session must remain reachable via real Tab presses.
    // E2E fixture has no experiments enabled, so top nav = New chat + Automations
    // + Workspaces. From Automations: Tab → Workspaces → Tab → search input.
    const searchInput = nav.getByRole("textbox", { name: "Search chats" });
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(searchInput).toBeFocused();

    await page.keyboard.press("Tab");
    const firstSession = nav.locator('[data-testid="session-item"]').first();
    await expect(firstSession).toBeFocused();

    // Extensions, Heartbeat, Activity, Integrations, Settings live inside the
    // bottom-bar More menu now. Open it via mouse, then activate a menu item.
    // `exact: true` avoids matching session-item kebab triggers that are
    // aria-labeled "More actions".
    await nav.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: /Extensions/ }).click();
    await expect(page.getByText("Your Skills")).toBeVisible({ timeout: 5000 });

    // Settings activation via keyboard: focus the More trigger, open with Enter,
    // then ArrowDown through each item asserting focus along the way. Awaiting
    // each focus assertion between presses lets Radix's roving-focus state
    // settle — rapid back-to-back `keyboard.press` calls without awaits get
    // coalesced and silently drop ~half the keystrokes. We focus directly
    // (rather than tabbing through the session list) because the session count
    // varies between runs; we explicitly assert the More button is keyboard-
    // reachable below so a regression that drops it from tab order would still
    // fail.
    const moreBtn = nav.getByRole("button", { name: "More", exact: true });
    await expect(moreBtn).not.toHaveAttribute("tabindex", "-1");
    await moreBtn.focus();
    await expect(moreBtn).toBeFocused();
    await page.keyboard.press("Enter");

    // Discover the actual More-menu items in DOM order so the test stays robust
    // to MORE_MENU_VIEWS additions or reordering — no hardcoded count to drift.
    const moreMenu = page.getByRole("menu");
    await expect(moreMenu).toBeVisible();
    const itemNames = (await moreMenu.getByRole("menuitem").allTextContents()).map((t) => t.trim());
    expect(itemNames.length).toBeGreaterThan(0);
    expect(itemNames[itemNames.length - 1]).toMatch(/Settings/);

    // Menu auto-focuses the first item on open.
    await expect(moreMenu.getByRole("menuitem").nth(0)).toBeFocused();
    for (let i = 1; i < itemNames.length; i++) {
      // eslint-disable-next-line no-await-in-loop -- intentional: Radix's roving-focus state must settle between keystrokes; parallel awaits would race and silently drop keys
      await page.keyboard.press("ArrowDown");
      // eslint-disable-next-line no-await-in-loop -- see above
      await expect(moreMenu.getByRole("menuitem").nth(i)).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(page.locator("main").getByText("Settings").first()).toBeVisible({
      timeout: 5000,
    });
  });
});
