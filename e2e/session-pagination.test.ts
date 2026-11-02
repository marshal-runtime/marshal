import { test, expect } from "./marshal-fixtures";

test("fills the chat viewport from mixed pages and continues near the bottom", async ({ page }) => {
  const viewport = page.getByLabel("Session list");
  const virtualList = page.getByTestId("wide-session-virtual-list");
  const virtualHeight = () =>
    virtualList.evaluate((element) =>
      Number.parseFloat(element.getAttribute("style")?.match(/height:\s*([\d.]+)/)?.[1] ?? "0"),
    );

  await expect.poll(virtualHeight).toBeGreaterThan(1_200);
  const initialHeight = await virtualHeight();

  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect.poll(virtualHeight).toBeGreaterThan(initialHeight + 1_000);
});
