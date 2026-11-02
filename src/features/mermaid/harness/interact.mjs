/* eslint-disable no-console, no-await-in-loop -- dev-only script: drives the viewer step by step, results to stdout. */
// Exercises the Mermaid viewer in the harness: hover, wheel zoom, drag, touch
// pan and pinch, fullscreen, source view, error view, copy, SVG/PNG export.
//   node src/features/mermaid/harness/interact.mjs [outDir]
// Needs the harness dev server running (see vite.config.ts in this folder).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

const outDir = process.argv[2] ?? path.join(os.tmpdir(), "mermaid-harness");
const base =
  process.env.HARNESS_URL ?? "http://localhost:5599/src/features/mermaid/harness/index.html";
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const ready = (page) =>
  page.waitForFunction(
    () =>
      [...document.querySelectorAll("section[data-fixture]")].every((section) =>
        section.querySelector("svg[aria-roledescription], [data-mermaid-error]"),
      ),
    undefined,
    { timeout: 30_000 },
  );

const transformOf = (locator) =>
  locator.evaluate(
    (element) => element.querySelector("[data-marshal-mermaid='stage']").style.transform,
  );

const scaleOf = async (locator) =>
  Number(/scale\(([\d.]+)\)/.exec(await transformOf(locator))?.[1]);

const browser = await chromium.launch();

// ── Desktop ────────────────────────────────────────────────────────────────
{
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.goto(`${base}?theme=light&surface=chat&fixtures=long-labels,datadog,broken`);
  await ready(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);

  const datadog = page.locator("section[data-fixture='datadog']");
  const longLabels = page.locator("section[data-fixture='long-labels']");
  const longViewport = longLabels.locator("[data-marshal-mermaid='viewport']");

  // Hover: node + its edges light up, the rest dims.
  await datadog.scrollIntoViewIfNeeded();
  const node = datadog.locator("g.node").nth(1);
  await node.hover();
  await page.waitForTimeout(250);
  const hover = await datadog.evaluate((section) => ({
    focus: section.querySelector("svg[aria-roledescription]")?.hasAttribute("data-mermaid-focus"),
    edges: section.querySelectorAll("path[data-edge][data-mermaid-active]").length,
    nodes: section.querySelectorAll("g.node[data-mermaid-active]").length,
    activeOpacity: getComputedStyle(section.querySelector("path[data-edge][data-mermaid-active]"))
      .opacity,
    dimmedOpacity: getComputedStyle(section.querySelector("g.node:not([data-mermaid-active])"))
      .opacity,
  }));
  check(
    "hover highlights a node and its edges",
    hover.focus &&
      hover.edges >= 1 &&
      hover.activeOpacity === "1" &&
      Number(hover.dimmedOpacity) < 0.5,
    JSON.stringify(hover),
  );
  await datadog.screenshot({ path: path.join(outDir, "after-desktop-hover-datadog.png") });
  await page.mouse.move(5, 5);

  // Ctrl + wheel zooms at the cursor; plain wheel inline leaves the page scrolling.
  await longLabels.scrollIntoViewIfNeeded();
  const before = await scaleOf(longLabels);
  const box = await longViewport.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -400);
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
  const zoomed = await scaleOf(longLabels);
  check("ctrl+wheel zooms in", zoomed > before * 1.5, `${before} → ${zoomed}`);

  // Drag pans.
  const t0 = await transformOf(longLabels);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2 - 30, { steps: 8 });
  await page.mouse.up();
  const t1 = await transformOf(longLabels);
  check("mouse drag pans", t0 !== t1, `${t0} → ${t1}`);
  await longLabels.hover();
  await longLabels.screenshot({ path: path.join(outDir, "after-desktop-zoomed-long-labels.png") });

  // Reset returns to fit-to-width.
  await longLabels.getByRole("button", { name: "Fit to width" }).click();
  check("reset returns to fit", Math.abs((await scaleOf(longLabels)) - before) < 0.001);

  // Zoom buttons.
  await longLabels.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(100);
  const afterButton = await scaleOf(longLabels);
  check("zoom-in button", afterButton > before, `${before} → ${afterButton}`);
  await longLabels.getByRole("button", { name: "Fit to width" }).click();

  // Source view.
  await longLabels.getByRole("button", { name: "View source" }).click();
  check(
    "view source shows the code",
    await longLabels.locator("[data-marshal-mermaid='source']").isVisible(),
  );
  await longLabels.screenshot({ path: path.join(outDir, "after-desktop-source-view.png") });
  await longLabels.getByRole("button", { name: "Show diagram" }).click();

  // Copy.
  await longLabels.getByRole("button", { name: "Copy source" }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(
    "copy puts the source on the clipboard",
    clip.startsWith("flowchart LR"),
    clip.slice(0, 30),
  );

  // Downloads.
  for (const format of ["SVG", "PNG"]) {
    await longLabels.getByRole("button", { name: "Download" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }),
      page.getByRole("menuitem", { name: `Download ${format}` }).click(),
    ]);
    const target = path.join(outDir, `after-export-long-labels.${format.toLowerCase()}`);
    await download.saveAs(target);
    const bytes = fs.readFileSync(target);
    const ok =
      format === "SVG"
        ? bytes.toString("utf8").includes("<svg") && bytes.toString("utf8").includes("@font-face")
        : bytes.subarray(1, 4).toString() === "PNG";
    const detail =
      format === "PNG"
        ? `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}px`
        : `${bytes.length} bytes, font embedded`;
    check(`download ${format}`, ok, `${download.suggestedFilename()} ${detail}`);
  }

  // Error view, on a fresh page so nothing from the steps above overlays it.
  await page.goto(`${base}?theme=light&surface=chat&fixtures=broken`);
  await ready(page);
  const broken = page.locator("section[data-fixture='broken']");
  const errorBlock = broken.locator("[data-mermaid-error]");
  const errorShown = (await errorBlock.locator("pre").first().textContent()).includes(
    "Parse error",
  );
  const sourceShown = (await errorBlock.locator("pre").last().textContent()).includes(
    "A[Start --> B{oops",
  );
  check("render error shows the source with the error", errorShown && sourceShown);
  await broken.screenshot({ path: path.join(outDir, "after-desktop-error.png") });

  // Fullscreen: whole width fitted, top visible, wheel pans, Escape closes.
  await page.goto(`${base}?theme=light&surface=chat&fixtures=datadog`);
  await ready(page);
  await page.waitForTimeout(500);
  await datadog.getByRole("button", { name: "Open fullscreen" }).click();
  const dialog = page.locator("[data-marshal-mermaid='fullscreen']");
  await dialog.waitFor();
  await page.waitForTimeout(400);
  const fit = await dialog.evaluate((element) => {
    const viewport = element
      .querySelector("[data-marshal-mermaid='viewport']")
      .getBoundingClientRect();
    const svg = element.querySelector("svg[aria-roledescription]").getBoundingClientRect();
    return {
      svgTopVisible: svg.top >= viewport.top - 1,
      widthFits: svg.right <= viewport.right + 1 && svg.left >= viewport.left - 1,
    };
  });
  check(
    "fullscreen fits width with the top visible",
    fit.svgTopVisible && fit.widthFits,
    JSON.stringify(fit),
  );
  await page.screenshot({ path: path.join(outDir, "after-desktop-fullscreen-datadog.png") });
  const fsBefore = await transformOf(dialog);
  const fsBox = await dialog.locator("[data-marshal-mermaid='viewport']").boundingBox();
  await page.mouse.move(fsBox.x + fsBox.width / 2, fsBox.y + fsBox.height / 2);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(200);
  check("fullscreen wheel pans down", fsBefore !== (await transformOf(dialog)));
  await page.screenshot({
    path: path.join(outDir, "after-desktop-fullscreen-datadog-scrolled.png"),
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape closes fullscreen", (await dialog.count()) === 0);

  // Dark fullscreen for the record.
  await page.goto(`${base}?theme=dark&surface=chat&fixtures=datadog`);
  await ready(page);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Open fullscreen" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "after-desktop-dark-fullscreen-datadog.png") });
  await context.close();
}

// ── Phone, 390px, touch ────────────────────────────────────────────────────
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`${base}?theme=light&surface=chat&fixtures=sequence,datadog`);
  await ready(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });

  const datadog = page.locator("section[data-fixture='datadog']");
  const controlsHidden = await datadog
    .locator("[data-marshal-mermaid='zoom-controls']")
    .evaluate((element) => getComputedStyle(element).display === "none");
  check("phone: inline zoom pill hidden (pinch instead)", controlsHidden);

  await datadog.getByRole("button", { name: "Open fullscreen" }).tap();
  const dialog = page.locator("[data-marshal-mermaid='fullscreen']");
  await dialog.waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "after-mobile-fullscreen-datadog.png") });

  const box = await dialog.locator("[data-marshal-mermaid='viewport']").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Pinch out.
  const s0 = await scaleOf(dialog);
  await touch("touchStart", [
    [cx - 30, cy],
    [cx + 30, cy],
  ]);
  for (let step = 1; step <= 10; step += 1) {
    await touch("touchMove", [
      [cx - 30 - step * 12, cy],
      [cx + 30 + step * 12, cy],
    ]);
  }
  await touch("touchEnd", []);
  await page.waitForTimeout(200);
  const s1 = await scaleOf(dialog);
  check("phone: pinch zooms in", s1 > s0 * 2, `${s0} → ${s1}`);

  // One-finger pan.
  const t0 = await transformOf(dialog);
  await touch("touchStart", [[cx, cy]]);
  for (let step = 1; step <= 8; step += 1)
    await touch("touchMove", [[cx - step * 15, cy - step * 20]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(200);
  check("phone: one-finger pan", t0 !== (await transformOf(dialog)));
  await page.screenshot({ path: path.join(outDir, "after-mobile-fullscreen-datadog-pinched.png") });

  await dialog.getByRole("button", { name: "Close fullscreen" }).tap();
  await page.waitForTimeout(300);
  check("phone: close fullscreen", (await dialog.count()) === 0);

  // Expand affordance on the phone.
  await datadog.locator("[data-mermaid-expand]").tap();
  await page.waitForTimeout(400);
  await datadog.screenshot({
    path: path.join(outDir, "after-mobile-light-chat-datadog-expanded-tap.png"),
  });
  check(
    "phone: expand shows the whole diagram",
    (await datadog.getByRole("button", { name: "Collapse" }).count()) === 1,
  );
  await context.close();
}

await browser.close();
fs.writeFileSync(path.join(outDir, "after-interactions.json"), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.ok).length;
console.log(`${results.length - failed}/${results.length} interaction checks passed`);
process.exitCode = failed ? 1 : 0;
