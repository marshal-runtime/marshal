/* eslint-disable no-console, no-await-in-loop -- dev-only script: sequential screenshots, results to stdout. */
// Screenshots the Mermaid harness and counts clipped labels and clipped containers.
//   node src/features/mermaid/harness/check.mjs <label> [outDir]
// Needs the harness dev server running (see vite.config.ts in this folder).
// A label counts as clipped when its laid-out text box pokes out of its
// foreignObject (which clips) or out of its node shape by more than 1px.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

const label = process.argv[2] ?? "run";
const outDir = process.argv[3] ?? path.join(os.tmpdir(), "mermaid-harness");
const base =
  process.env.HARNESS_URL ?? "http://localhost:5599/src/features/mermaid/harness/index.html";
fs.mkdirSync(outDir, { recursive: true });

const configs = [
  {
    name: "desktop-light-chat",
    viewport: { width: 1280, height: 900 },
    theme: "light",
    surface: "chat",
  },
  {
    name: "desktop-dark-chat",
    viewport: { width: 1280, height: 900 },
    theme: "dark",
    surface: "chat",
  },
  {
    name: "desktop-light-preview",
    viewport: { width: 1280, height: 900 },
    theme: "light",
    surface: "preview",
  },
  {
    name: "mobile-light-chat",
    viewport: { width: 390, height: 844 },
    theme: "light",
    surface: "chat",
    mobile: true,
  },
  {
    name: "mobile-dark-chat",
    viewport: { width: 390, height: 844 },
    theme: "dark",
    surface: "chat",
    mobile: true,
  },
];

function measureClipping() {
  const pad = 1;
  const outside = (inner, outer) =>
    inner.left < outer.left - pad ||
    inner.right > outer.right + pad ||
    inner.top < outer.top - pad ||
    inner.bottom > outer.bottom + pad;
  const textBox = (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return null;
    return {
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  };
  const results = {};
  const box = (rect) => `${Math.round(rect.width)}x${Math.round(rect.height)}`;
  for (const section of document.querySelectorAll("section[data-fixture]")) {
    const name = section.getAttribute("data-fixture");
    const svg = section.querySelector("svg[aria-roledescription]");
    const entry = { rendered: Boolean(svg), labels: 0, clipped: 0, samples: [], container: null };
    results[name] = entry;
    if (!svg) continue;
    // Container clip: any ancestor that hides overflow and cuts the diagram's box.
    // A cut is "explained" when the viewer shows an expand affordance for it.
    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox?.baseVal;
    const container = {
      svg: box(svgRect),
      natural: viewBox ? `${Math.round(viewBox.width)}x${Math.round(viewBox.height)}` : null,
      scale: viewBox?.width ? Number((svgRect.width / viewBox.width).toFixed(3)) : null,
      clipped: false,
      hiddenPx: 0,
      clipper: null,
      affordance: Boolean(section.querySelector("[data-mermaid-expand]")),
    };
    for (let el = svg.parentElement; el && el !== section; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const rect = el.getBoundingClientRect();
      const hidden = Math.max(
        0,
        svgRect.bottom - rect.bottom,
        rect.top - svgRect.top,
        svgRect.right - rect.right,
        rect.left - svgRect.left,
      );
      if (hidden > 1) {
        container.clipped = true;
        container.hiddenPx = Math.max(container.hiddenPx, Math.round(hidden));
        container.clipper ??= {
          element: `${el.tagName.toLowerCase()}${el.dataset.streamdown ? `[data-streamdown=${el.dataset.streamdown}]` : ""}${el.dataset.marshalMermaid ? `[data-marshal-mermaid=${el.dataset.marshalMermaid}]` : ""}`,
          box: box(rect),
          overflow: `${style.overflowX}/${style.overflowY}`,
        };
      }
    }
    entry.container = container;
    const check = (labelEl, shapeEl, kind) => {
      const text = textBox(labelEl);
      if (!text) return;
      entry.labels += 1;
      const clip = labelEl.closest("foreignObject");
      const reasons = [];
      if (clip && outside(text, clip.getBoundingClientRect())) reasons.push("foreignObject");
      if (shapeEl && outside(text, shapeEl.getBoundingClientRect())) reasons.push("shape");
      if (reasons.length) {
        entry.clipped += 1;
        if (entry.samples.length < 8)
          entry.samples.push({ kind, text: labelEl.textContent.trim().slice(0, 60), reasons });
      }
    };
    for (const node of svg.querySelectorAll("g.node")) {
      const shape = node.querySelector(
        ":scope > rect, :scope > polygon, :scope > circle, :scope > ellipse, :scope > path, :scope > g.basic > path, :scope > g > path, .label-container",
      );
      const labelEl = node.querySelector("foreignObject div, foreignObject span, text");
      if (labelEl) check(labelEl, shape, "node");
    }
    for (const edgeLabel of svg.querySelectorAll("g.edgeLabel")) {
      const labelEl = edgeLabel.querySelector("foreignObject div, text");
      if (labelEl) check(labelEl, null, "edge");
    }
    for (const actor of svg.querySelectorAll("rect.actor")) {
      const group = actor.parentElement;
      const labelEl = group?.querySelector("text.actor, text");
      if (labelEl) check(labelEl, actor, "actor");
    }
    for (const note of svg.querySelectorAll("rect.note")) {
      const labelEl = note.parentElement?.querySelector("text.noteText");
      if (labelEl) check(labelEl, note, "note");
    }
  }
  return results;
}

const browser = await chromium.launch();
const report = {};
for (const config of configs) {
  const context = await browser.newContext({
    viewport: config.viewport,
    deviceScaleFactor: 2,
    isMobile: Boolean(config.mobile),
    hasTouch: Boolean(config.mobile),
  });
  const page = await context.newPage();
  await page.goto(`${base}?theme=${config.theme}&surface=${config.surface}`);
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("section[data-fixture]")].every((section) =>
          section.querySelector("svg[aria-roledescription], [data-mermaid-error]"),
        ),
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => console.log(`${config.name}: not every fixture rendered within 30s`));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  report[config.name] = await page.evaluate(measureClipping);
  const shot = path.join(outDir, `${label}-${config.name}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  for (const fixture of ["datadog", "long-labels"]) {
    const section = page.locator(`section[data-fixture='${fixture}']`);
    await section.screenshot({ path: path.join(outDir, `${label}-${config.name}-${fixture}.png`) });
  }
  // Expanded state: every capped diagram should show in full with nothing cut.
  const expanders = page.locator("[data-mermaid-expand]");
  if ((await expanders.count()) > 0) {
    for (const button of await expanders.all()) await button.click();
    await page.waitForTimeout(400);
    report[`${config.name}-expanded`] = await page.evaluate(measureClipping);
    await page
      .locator("section[data-fixture='datadog']")
      .screenshot({ path: path.join(outDir, `${label}-${config.name}-datadog-expanded.png`) });
  }
  await context.close();
}
await browser.close();
fs.writeFileSync(path.join(outDir, `${label}-clip-report.json`), JSON.stringify(report, null, 2));
let labelTotal = 0;
let containerCuts = 0;
let explainedCuts = 0;
for (const [name, fixtures] of Object.entries(report)) {
  const summary = Object.entries(fixtures)
    .map(([fixture, entry]) => {
      labelTotal += entry.clipped;
      const cut = entry.container?.clipped;
      if (cut && entry.container.affordance) explainedCuts += 1;
      else if (cut) containerCuts += 1;
      const containerNote = !entry.container
        ? ""
        : `, container ${cut ? `CUT ${entry.container.hiddenPx}px${entry.container.affordance ? " (expand affordance)" : ""}` : "ok"}, scale ${entry.container.scale}`;
      return `${fixture}: ${entry.clipped}/${entry.labels} labels clipped${containerNote}${entry.rendered ? "" : " (no svg)"}`;
    })
    .join(" | ");
  console.log(`${name}: ${summary}`);
}
console.log(
  `TOTAL clipped labels=${labelTotal} clipped containers=${containerCuts} capped-with-expand=${explainedCuts}`,
);
