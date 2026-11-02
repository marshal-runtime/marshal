import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const BADGE_FONT_SOURCE = "public/fonts/Geist-Variable.woff2";
export const BADGE_FONT_SOURCE_SHA256 =
  "a369fcf5628ea2aa4e1b9e2ec6a5b3624e365bda588e1f0f2f12b564f728fbb8";
export const BADGE_FONT_LICENSE = "public/fonts/Geist-LICENSE.txt";
export const BADGE_FONT_LICENSE_SHA256 =
  "930853ee1daa68554d9e35c8a9175affb74f699fad9a5da6ee5ebe76379d9137";

const UNITS_PER_EM = 1000;
const TRACKING = 12;
const VISUAL_CENTER = 355;

const GLYPHS = {
  A: {
    advance: 730,
    path: "M18.8 0 274.8 710H454.997L710.997 0H553.4L500.999 151.002H228.198L175.797 0ZM270.998 275.8H458.8L365.199 550.403Z",
  },
  B: {
    advance: 703,
    path: "M74.001 0V710H350.399Q482.399 710 552.299 663.7Q622.199 617.4 622.199 517.2Q622.199 473 604.299 440.4Q586.398 407.8 551.798 388.9Q517.198 370 467.998 366.4L467.598 367.6Q557.398 362.2 604.798 316.7Q652.199 271.2 652.199 195.6Q652.199 96.8 582.599 48.4Q512.999 0 384.4 0ZM225.998 123.598H376.6Q431.601 123.598 465.101 146.099Q498.601 168.599 498.601 213.799Q498.601 259 465.401 282.4Q432.201 305.801 376.6 305.801H225.998ZM225.998 416.199H345.6Q402 416.199 435.301 437.9Q468.601 459.6 468.601 501.201Q468.601 545.201 436.201 565.801Q403.801 586.402 345.6 586.402H225.998Z",
  },
  D: {
    advance: 716,
    path: "M74.001 0V710H318.6Q491.599 710 584.599 617.5Q677.599 525 677.599 354Q677.599 184 586.099 92Q494.599 0 324.6 0ZM225.998 127.798H318.6Q422.001 127.798 471.501 183.599Q521.002 239.399 521.002 354.6Q521.002 470.601 471.501 526.401Q422.001 582.202 318.6 582.202H225.998Z",
  },
  E: {
    advance: 622,
    path: "M74.001 0V710H567.999V582.202H225.998V419.199H555.999V292.801H225.998V127.798H575.999V0Z",
  },
  T: {
    advance: 599,
    path: "M223.4 0V582.202H10.8V710H588.598V582.202H375.998V0Z",
  },
  V: {
    advance: 730,
    path: "M275.2 0 18.8 710H176.397L365.199 170.797L553.6 710H711.197L453.597 0Z",
  },
};

const REQUIRED_LABELS = ["DEV", "BETA", "D", "B"];

function glyphsFor(text) {
  return [...text].map((character) => {
    const glyph = GLYPHS[character];
    if (!glyph) throw new Error(`No deterministic badge glyph for "${character}"`);
    return glyph;
  });
}

function formatNumber(value) {
  return String(Number(value.toFixed(4)));
}

export function measureBadgeTextEm(text) {
  const glyphs = glyphsFor(text);
  const units =
    glyphs.reduce((total, glyph) => total + glyph.advance, 0) +
    Math.max(0, glyphs.length - 1) * TRACKING;
  return units / UNITS_PER_EM;
}

export function badgeTextSvg(text, { centerX, centerY, fontSize, fill = "#FFFFFF" }) {
  const glyphs = glyphsFor(text);
  const scale = fontSize / UNITS_PER_EM;
  const widthUnits = measureBadgeTextEm(text) * UNITS_PER_EM;
  const startX = centerX - (widthUnits * scale) / 2;
  const baselineY = centerY + VISUAL_CENTER * scale;
  let cursor = 0;
  const paths = glyphs
    .map((glyph) => {
      const pathData = `<path d="${glyph.path}" fill="${fill}" transform="translate(${formatNumber(cursor)} 0)"/>`;
      cursor += glyph.advance + TRACKING;
      return pathData;
    })
    .join("");

  return `<g transform="translate(${formatNumber(startX)} ${formatNumber(baselineY)}) scale(${formatNumber(scale)} ${formatNumber(-scale)})">${paths}</g>`;
}

export function serializeBadgeGlyphProvenance() {
  const glyphs = Object.entries(GLYPHS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([character, glyph]) => `${character}|${glyph.advance}|${glyph.path}`)
    .join("\n");
  return `${glyphs}\nlabels|${REQUIRED_LABELS.join(",")}`;
}

export function validateBadgeGlyphResources(root) {
  const sourcePath = path.join(root, ...BADGE_FONT_SOURCE.split("/"));
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing deterministic badge font source: ${BADGE_FONT_SOURCE}`);
  }
  const digest = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  if (digest !== BADGE_FONT_SOURCE_SHA256) {
    throw new Error(
      `Bundled badge font digest changed (${digest}); regenerate and review scripts/lib/badge-glyphs.mjs.`,
    );
  }
  const licensePath = path.join(root, ...BADGE_FONT_LICENSE.split("/"));
  if (!existsSync(licensePath)) {
    throw new Error(`Missing deterministic badge font license: ${BADGE_FONT_LICENSE}`);
  }
  const licenseDigest = createHash("sha256").update(readFileSync(licensePath)).digest("hex");
  if (licenseDigest !== BADGE_FONT_LICENSE_SHA256) {
    throw new Error(`Bundled badge font license digest changed (${licenseDigest}).`);
  }
  for (const label of REQUIRED_LABELS) glyphsFor(label);
  return {
    source: BADGE_FONT_SOURCE,
    digest,
    license: BADGE_FONT_LICENSE,
    licenseDigest,
    labels: REQUIRED_LABELS,
  };
}
