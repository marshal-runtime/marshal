#!/usr/bin/env node

// Runtime half of the visual-identity proof. scripts/verify-rebrand.mjs checks
// what is in the source; this checks what the RENDERER actually resolves, which
// source inspection cannot answer:
//
//   - a stale cached bundle would still render something plausible
//   - a @font-face can be declared and never load (silent fallback)
//   - a token can be defined and then overridden by an inline style downstream
//
// Two defects in the rebrand were invisible to every static gate and only
// surfaced here: raster welcome-card art that no CSS variable could reach, and a
// six-stop gradient set inline in ChatPanel.tsx.
//
// Usage — start a build with remote debugging, then:
//   pnpm electron:debug                      # in another terminal
//   PORT=9222 OUT=./dist/visual-proof node scripts/visual-proof.mjs
//
// Point it at an isolated profile to get a reproducible, content-free capture:
// MARSHAL_E2E=1 routes the app-data dir to a temp root, so the sidebar renders
// empty instead of showing whatever sessions happen to be on the machine. The
// stylesheet, fonts and icons are the real ones either way — E2E only stubs the
// backend — so the identity being measured here is unaffected.
//
// Exits non-zero if any check fails, and writes visual-proof.json plus a
// screenshot per theme to OUT.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { connectToApp, evaluate, sleep, waitForReady } from "./harness-verify/cdp-helpers.mjs";

const PORT = Number(process.env.PORT || 9222);
const OUT = process.env.OUT || join(process.cwd(), "dist", "visual-proof");
mkdirSync(OUT, { recursive: true });

// Kept in the same spelling as src/index.css so a reviewer can diff them by eye;
// the browser normalises both sides before they are compared.
const EXPECT = {
  font: "Geist",
  light: { background: "hsl(240, 30%, 98%)", brand: "hsl(250, 66%, 52%)" },
  dark: { background: "hsl(240, 10%, 7%)", brand: "hsl(252, 92%, 76%)" },
};

const PROBE = `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const bodyCs = getComputedStyle(document.body);
  const v = (n) => cs.getPropertyValue(n).trim();
  return JSON.stringify({
    themeAttr: root.getAttribute("data-theme"),
    bodyFontFamily: bodyCs.fontFamily,
    bodyBackground: bodyCs.backgroundColor,
    bodyColor: bodyCs.color,
    tokens: {
      background: v("--background"),
      foreground: v("--foreground"),
      brandAction: v("--brand-action"),
      messageAssistantBg: v("--message-assistant-bg"),
      radius: v("--radius"),
    },
    // document.fonts only lists faces the page actually requested, so a face
    // reporting "loaded" is proof the woff2 was fetched and parsed.
    geistFacesLoaded: [...document.fonts].filter((f) => /Geist/i.test(f.family)).map((f) => f.family + ":" + f.status),
    legacyFacesPresent: [...document.fonts].filter((f) => /Segoe/i.test(f.family)).map((f) => f.family),
    svgCount: document.querySelectorAll("svg").length,
  });
})()`;

const unwrap = (r) => (typeof r === "object" && r !== null ? (r.value ?? r.result?.value ?? r) : r);
// Deliberately holds no absolute path, port or timestamp: a reviewer re-running
// this against the same commit should get a byte-identical file they can diff,
// so drift shows up as a real difference rather than as machine noise.
const results = { checks: [], shots: {} };

function check(label, actual, expected, mode = "equals") {
  const ok =
    mode === "includes"
      ? String(actual).toLowerCase().includes(String(expected).toLowerCase())
      : mode === "empty"
        ? Array.isArray(actual) && actual.length === 0
        : String(actual) === String(expected);
  results.checks.push({ label, expected, actual, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`        expected ${mode}: ${expected}`);
  console.log(`        actual        : ${JSON.stringify(actual)}`);
  return ok;
}

// The renderer serialises hsl() to hex and emits oklab() for alpha-composited
// colours, so comparing colour STRINGS is meaningless. Round both sides through
// the browser's own parser first.
async function normalizeColor(Runtime, color) {
  return String(
    unwrap(
      await evaluate(
        Runtime,
        `(() => {
          const el = document.createElement("span");
          el.style.color = ${JSON.stringify(color)};
          document.body.appendChild(el);
          const v = getComputedStyle(el).color;
          el.remove();
          return v;
        })()`,
      ),
    ),
  );
}

async function checkColor(Runtime, label, actualRaw, expectedRaw) {
  const [a, e] = await Promise.all([
    normalizeColor(Runtime, actualRaw),
    normalizeColor(Runtime, expectedRaw),
  ]);
  const ok = a === e && a !== "";
  results.checks.push({
    label,
    expected: `${expectedRaw} (${e})`,
    actual: `${actualRaw} (${a})`,
    ok,
  });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`        expected: ${expectedRaw} -> ${e}`);
  console.log(`        actual  : ${actualRaw} -> ${a}`);
  return ok;
}

async function setTheme(Runtime, theme) {
  await evaluate(
    Runtime,
    `(() => {
      const r = document.documentElement;
      r.setAttribute("data-theme", ${JSON.stringify(theme)});
      r.setAttribute("data-theme-mode", ${JSON.stringify(theme)});
      try { localStorage.setItem("theme-mode", ${JSON.stringify(theme)}); } catch {}
      return r.getAttribute("data-theme");
    })()`,
  );
  await sleep(900);
}

const { Runtime, Page, client } = await connectToApp(PORT);
try {
  await Page.enable();
  await sleep(1500);
  await waitForReady(Runtime);

  for (const theme of ["light", "dark"]) {
    await setTheme(Runtime, theme);
    const p = JSON.parse(String(unwrap(await evaluate(Runtime, PROBE))));
    results[theme] = p;
    console.log(`\n--- ${theme} ---`);

    check(
      `[${theme}] body font-family resolves to Geist`,
      p.bodyFontFamily,
      EXPECT.font,
      "includes",
    );
    check(
      `[${theme}] Geist face loaded by the renderer`,
      p.geistFacesLoaded.join(","),
      "Geist",
      "includes",
    );
    check(`[${theme}] no legacy Segoe faces remain`, p.legacyFacesPresent, [], "empty");
    await checkColor(
      Runtime,
      `[${theme}] --background token`,
      p.tokens.background,
      EXPECT[theme].background,
    );
    await checkColor(
      Runtime,
      `[${theme}] --brand-action token`,
      p.tokens.brandAction,
      EXPECT[theme].brand,
    );
    check(
      `[${theme}] assistant bubble is surface-less`,
      p.tokens.messageAssistantBg,
      "transparent",
    );

    const { data } = await Page.captureScreenshot({ format: "png" });
    const name = `marshal-${theme}.png`;
    writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
    results.shots[theme] = name;
    console.log(`        screenshot -> ${join(OUT, name)}`);
    console.log(`        svg icons rendered: ${p.svgCount}`);
  }

  const failed = results.checks.filter((c) => !c.ok);
  results.verdict = failed.length === 0 ? "PASS" : `FAIL (${failed.length})`;
  writeFileSync(join(OUT, "visual-proof.json"), JSON.stringify(results, null, 2));
  console.log(`\nVERDICT: ${results.verdict}   (${results.checks.length} checks)`);
  if (failed.length) process.exitCode = 1;
} finally {
  await client.close();
}
