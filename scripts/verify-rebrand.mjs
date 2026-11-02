#!/usr/bin/env node

// Verifies Marshal's VISUAL identity — the counterpart to verify-brand.mjs,
// which covers the textual brand. Everything here is statically checkable from
// a checkout, so a reviewer with no session context can run one command and get
// a verdict.
//
// It deliberately re-derives values rather than trusting prose: colours are
// converted hsl -> rgb and compared numerically, because the same colour is
// spelled hsl() in CSS, #hex in electron/theme.ts and rgb() by getComputedStyle.
// String comparison across those three would be meaningless.
//
// Runtime-only claims (does the renderer actually LOAD Geist, what does
// getComputedStyle resolve) cannot be checked from source and are covered by
// scripts/visual-proof.mjs against a running build.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

import { buildGeneratedIconAssets, GENERATED_ICON_PATHS } from "./lib/generated-icon-assets.mjs";
import { parseIcoEntries } from "./lib/ico.mjs";
import { parseIcnsEntries } from "./lib/marshal-icns.mjs";

const rootArgIndex = process.argv.indexOf("--root");
const root = path.resolve(rootArgIndex >= 0 ? process.argv[rootArgIndex + 1] : process.cwd());
const BADGE_GLYPH_PROVENANCE_SHA256 =
  "fa376bb3267d84ec6a26a96576a5a5c868a3d1450c801e9826bd8967e2e26465";

const checks = [];
const results = [];
const check = (id, fn) => checks.push({ id, fn });

const read = (rel) => {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) throw new Error(`missing file: ${rel}`);
  return readFileSync(abs, "utf8");
};
const readBytes = (rel) => {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) throw new Error(`missing file: ${rel}`);
  return readFileSync(abs);
};
const must = (condition, message) => {
  if (!condition) throw new Error(message);
};
const absolute = (rel) => path.join(root, ...rel.split("/"));

function pngInfo(buffer, label) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  must(buffer.length >= 33 && buffer.subarray(0, 8).equals(signature), `${label} is not a PNG`);
  must(buffer.toString("ascii", 12, 16) === "IHDR", `${label} has no leading IHDR chunk`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

function requireRgbaPngBuffer(buffer, label, width, height) {
  const info = pngInfo(buffer, label);
  must(
    info.width === width && info.height === height && info.bitDepth === 8 && info.colorType === 6,
    `${label} must be ${width}x${height} 32-bit RGBA PNG; got ` +
      `${info.width}x${info.height}, depth ${info.bitDepth}, color type ${info.colorType}`,
  );
}

function requireRgbaPng(rel, width, height) {
  requireRgbaPngBuffer(readBytes(rel), rel, width, height);
}

async function rgbaPixels(image, label, width, height) {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  must(
    info.width === width && info.height === height && info.channels === 4,
    `${label} decoded as ${info.width}x${info.height}/${info.channels}ch, expected ${width}x${height}/4ch`,
  );
  return data;
}

async function filePixels(rel, width, height) {
  return rgbaPixels(sharp(absolute(rel)), rel, width, height);
}

function requireWhiteAlphaPixels(data, label) {
  let visible = 0;
  let colored = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    visible++;
    if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255) {
      colored++;
    }
  }
  must(visible > 0, `${label} has no visible pixels`);
  must(colored === 0, `${label} must be true white+alpha; found ${colored} colored pixels`);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** hsl(h, s%, l%) -> [r, g, b] in 0-255, matching how a browser rasterises it. */
function hslToRgb(h, s, l) {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = lig - c / 2;
  return [r1, g1, b1].map((v) => Math.round((v + m) * 255));
}

/** Pull `--token: hsl(a, b%, c%)` out of a stylesheet, nth occurrence. */
function cssHsl(css, token, occurrence = 0) {
  const re = new RegExp(
    `--${token}:\\s*hsl\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)%[,\\s]+([\\d.]+)%\\s*\\)`,
    "g",
  );
  const found = [...css.matchAll(re)];
  must(found.length > occurrence, `--${token}: no hsl() declaration #${occurrence + 1} found`);
  const m = found[occurrence];
  return { hsl: [Number(m[1]), Number(m[2]), Number(m[3])], rgb: hslToRgb(+m[1], +m[2], +m[3]) };
}

const rgbEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const fmt = (rgb) => `rgb(${rgb.join(", ")})`;

function walk(dir, out = []) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    if (entry === "node_modules" || entry === "__screenshots__" || entry.startsWith(".")) continue;
    const rel = path.posix.join(dir, entry);
    if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

function discoverGeneratedIconPaths() {
  const discovered = [];
  const publicRoot = absolute("public");
  if (existsSync(publicRoot)) {
    for (const name of readdirSync(publicRoot)) {
      if (
        /^(?:marshal-app-icon(?:-(?:dev|beta)(?:-(?:win|overlay))?)?\.png|marshal-tray-template(?:-(?:dev|beta))?(?:@2x)?\.png|marshal-tray-icon-(?:dev|beta)\.png|marshal-app-icon\.(?:ico|icns))$/.test(
          name,
        )
      ) {
        discovered.push(`public/${name}`);
      }
    }
  }
  const iconsetDir = absolute("public/macos-iconset");
  if (existsSync(iconsetDir)) {
    for (const name of readdirSync(iconsetDir)) {
      if (name.endsWith(".png")) discovered.push(`public/macos-iconset/${name}`);
    }
  }
  return discovered.sort();
}

// ---------------------------------------------------------------- typography

check("typography/vendored", () => {
  const dir = path.join(root, "public/fonts");
  must(existsSync(dir), "public/fonts is missing");
  const files = readdirSync(dir);
  for (const required of ["Geist-Variable.woff2", "GeistMono-Variable.woff2"]) {
    must(files.includes(required), `public/fonts/${required} is missing`);
  }
  must(
    files.some((f) => /licen[cs]e/i.test(f)),
    "public/fonts has no licence file — Geist is SIL OFL and must ship its licence",
  );
  must(
    files.some((f) => /readme/i.test(f)),
    "public/fonts has no README recording provenance",
  );
  return `${files.filter((f) => f.endsWith(".woff2")).length} woff2 + licence + provenance`;
});

check("typography/predecessor-removed", () => {
  const strays = walk("public").filter((f) => /segoe/i.test(f));
  must(strays.length === 0, `predecessor font files still present: ${strays.join(", ")}`);
  return "no Segoe font files remain";
});

check("typography/declared", () => {
  const css = read("src/index.css");
  must(/@font-face[^}]*font-family:\s*"Geist"/s.test(css), 'no @font-face for "Geist"');
  must(/@font-face[^}]*font-family:\s*"Geist Mono"/s.test(css), 'no @font-face for "Geist Mono"');
  must(/font-family:\s*\n?\s*"?Geist"?/.test(css), "body font stack does not lead with Geist");
  return "Geist + Geist Mono declared and used";
});

// ------------------------------------------------------------------ palette

const PALETTE = {
  "background-base": [
    { theme: "light", rgb: [248, 248, 251] },
    { theme: "dark", rgb: [16, 16, 20] },
  ],
  "brand-action": [
    { theme: "light", rgb: [79, 52, 213] },
    { theme: "dark", rgb: [160, 137, 250] },
  ],
};

check("palette/tokens", () => {
  const css = read("src/index.css");
  const seen = [];
  for (const [token, expectations] of Object.entries(PALETTE)) {
    expectations.forEach((expected, index) => {
      const actual = cssHsl(css, token, index);
      must(
        rgbEq(actual.rgb, expected.rgb),
        `--${token} (${expected.theme}) is ${fmt(actual.rgb)}, expected ${fmt(expected.rgb)}`,
      );
      seen.push(`${token}/${expected.theme}=${fmt(actual.rgb)}`);
    });
  }
  return seen.join(" ");
});

check("palette/cool-neutrals", () => {
  const css = read("src/index.css");
  const backgrounds = PALETTE["background-base"].map((_, i) => cssHsl(css, "background-base", i));
  for (const bg of backgrounds) {
    must(bg.hsl[0] === 240, `neutral hue is ${bg.hsl[0]}, expected 240 (cool graphite)`);
  }
  const accents = PALETTE["brand-action"].map((_, i) => cssHsl(css, "brand-action", i));
  for (const accent of accents) {
    must(
      accent.hsl[0] >= 245 && accent.hsl[0] <= 260,
      `accent hue is ${accent.hsl[0]}, expected iris (245-260)`,
    );
  }
  return "neutrals hue 240, accent iris";
});

// The window background is duplicated across surfaces that load before the
// renderer. A stale one shows as a colour flash on cold boot — no test and no
// screenshot can catch that, because both observe the app after it has painted.
check("palette/pre-paint-surfaces-in-sync", () => {
  const css = read("src/index.css");
  const light = cssHsl(css, "background-base", 0).rgb;
  const dark = cssHsl(css, "background-base", 1).rgb;

  const flash = read("public/marshal-flash-prevention.css");
  const flashColours = [
    ...flash.matchAll(/background:\s*hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*\)/g),
  ].map((m) => hslToRgb(+m[1], +m[2], +m[3]));
  must(
    flashColours.some((c) => rgbEq(c, light)),
    `public/marshal-flash-prevention.css has no background matching light ${fmt(light)} — cold boot would flash`,
  );
  must(
    flashColours.some((c) => rgbEq(c, dark)),
    `public/marshal-flash-prevention.css has no background matching dark ${fmt(dark)} — cold boot would flash`,
  );

  const theme = read("electron/theme.ts");
  const hexes = Object.fromEntries(
    [...theme.matchAll(/(light|dark):\s*"(#[0-9a-fA-F]{6})"/g)].map((m) => [m[1], m[2]]),
  );
  must(
    hexes.light && hexes.dark,
    "electron/theme.ts THEME_BG does not declare light and dark hex values",
  );
  const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  must(
    rgbEq(hexToRgb(hexes.light), light),
    `electron/theme.ts light ${hexes.light} != index.css ${fmt(light)} — native window paints the wrong colour`,
  );
  must(
    rgbEq(hexToRgb(hexes.dark), dark),
    `electron/theme.ts dark ${hexes.dark} != index.css ${fmt(dark)} — native window paints the wrong colour`,
  );
  return `index.css == marshal-flash-prevention.css == theme.ts (${fmt(light)} / ${fmt(dark)})`;
});

// -------------------------------------------------------------------- icons

check("icons/predecessor-removed", () => {
  const sources = [...walk("src"), ...walk("electron"), ...walk("common")].filter((f) =>
    /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f),
  );
  const offenders = sources.filter((f) =>
    /from\s+["']lucide-react["']/.test(readFileSync(path.join(root, f), "utf8")),
  );
  must(
    offenders.length === 0,
    `lucide-react still imported by: ${offenders.slice(0, 5).join(", ")}`,
  );

  const pkg = JSON.parse(read("package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  must(!deps["lucide-react"], "lucide-react is still a dependency in package.json");
  must(deps["@phosphor-icons/react"], "@phosphor-icons/react is not a dependency");
  return `${sources.length} sources scanned, zero lucide imports`;
});

check("icons/barrel-and-direction", () => {
  const barrel = read("src/components/icons/index.tsx");
  const declarationOf = (name) =>
    barrel.split(";\n").find((statement) => statement.includes(`export const ${name} =`));
  must(
    /@phosphor-icons\/react/.test(barrel),
    "icon barrel does not source from @phosphor-icons/react",
  );
  // Phosphor's sidebar glyphs face the opposite way to the predecessor's, so a
  // 1:1 swap silently reverses these four affordances while every gate stays green.
  for (const name of ["PanelRightClose", "PanelRightOpen"]) {
    const line = declarationOf(name);
    must(line, `${name} is not exported from the barrel`);
    must(/mirrored:\s*true/.test(line), `${name} is not mirrored — it would point the wrong way`);
  }
  for (const name of ["PanelLeftClose", "PanelLeftOpen"]) {
    const line = declarationOf(name);
    must(line, `${name} is not exported from the barrel`);
    must(!/mirrored:\s*true/.test(line), `${name} is mirrored — it would point the wrong way`);
  }
  return "barrel is Phosphor-backed, all four Panel* icons keep their direction";
});

check("icons/app-mark-source", () => {
  const wayfinderPaths = ["M5 18V7.5L12 13l7-5.5V18", "m5 7.5 7-3 7 3"];
  const iconSvg = read("public/marshal-app-icon.svg");
  const marshalSvg = read("public/marshal-icon.svg");
  const outlineSvg = read("public/marshal-icon-outline.svg");
  const navIcons = read("src/assets/icons/nav-icons.tsx");
  const generator = read("scripts/lib/generated-icon-assets.mjs");
  must(
    iconSvg === marshalSvg,
    "public/marshal-app-icon.svg and public/marshal-icon.svg have drifted",
  );
  must(/viewBox="0 0 24 24"/.test(iconSvg), "app mark does not use the approved 24px grid");
  must(/fill="#4F34D5"/i.test(iconSvg), "app tile is not the brand-action #4F34D5");
  must(!/<(?:linear|radial)Gradient/i.test(iconSvg), "app mark must not use a gradient");
  must(/<rect\b/.test(iconSvg), "app mark is missing its accent tile");
  must(!/<rect\b/.test(outlineSvg), "outline mark must remain a transparent silhouette");
  for (const pathData of wayfinderPaths) {
    for (const [name, source] of [
      ["public/marshal-app-icon.svg", iconSvg],
      ["public/marshal-icon-outline.svg", outlineSvg],
      ["src/assets/icons/nav-icons.tsx", navIcons],
    ]) {
      must(source.includes(pathData), `${name} is missing Wayfinder path ${pathData}`);
    }
  }
  must(!/<text\b|font-family=/i.test(generator), "badge generator still depends on host font text");
  return "Wayfinder SVG, outline, renderer avatar, and font-free generator source validated";
});

check("icons/badge-glyph-provenance", async () => {
  const modulePath = absolute("scripts/lib/badge-glyphs.mjs");
  const moduleUrl = `${pathToFileURL(modulePath).href}?verify=${sha256(readBytes("scripts/lib/badge-glyphs.mjs"))}`;
  const badgeGlyphs = await import(moduleUrl);
  const resource = badgeGlyphs.validateBadgeGlyphResources(root);
  const provenanceDigest = sha256(Buffer.from(badgeGlyphs.serializeBadgeGlyphProvenance()));
  must(
    provenanceDigest === BADGE_GLYPH_PROVENANCE_SHA256,
    `Badge glyph provenance digest mismatch: expected ${BADGE_GLYPH_PROVENANCE_SHA256}, got ${provenanceDigest}`,
  );
  return `6 glyph outlines/advances + ${resource.labels.length} labels + font/license hashes validated`;
});

check("icons/template-alpha", async () => {
  for (const [file, size] of [
    ["public/marshal-tray-template.png", 24],
    ["public/marshal-tray-template@2x.png", 48],
  ]) {
    const actual = await filePixels(file, size, size);
    requireWhiteAlphaPixels(actual, file);
  }
  return "release menu templates are true white+alpha masks";
});

check("icons/generated-assets", async () => {
  const expected = await buildGeneratedIconAssets(root);
  const expectedPaths = new Set(GENERATED_ICON_PATHS);
  const manifestMissing = GENERATED_ICON_PATHS.filter(
    (relativePath) => !expected.has(relativePath),
  );
  const manifestExtra = [...expected.keys()].filter(
    (relativePath) => !expectedPaths.has(relativePath),
  );
  must(
    manifestMissing.length === 0 && manifestExtra.length === 0,
    `Generated asset manifest mismatch. Missing: ${manifestMissing.join(", ") || "none"}; ` +
      `extra: ${manifestExtra.join(", ") || "none"}`,
  );

  const missing = [];
  const mismatched = [];
  for (const relativePath of GENERATED_ICON_PATHS) {
    if (!existsSync(absolute(relativePath))) {
      missing.push(relativePath);
      continue;
    }
    if (!readBytes(relativePath).equals(expected.get(relativePath))) mismatched.push(relativePath);
  }
  const unexpected = discoverGeneratedIconPaths().filter(
    (relativePath) => !expectedPaths.has(relativePath),
  );
  must(missing.length === 0, `Missing generated assets: ${missing.join(", ")}`);
  must(unexpected.length === 0, `Unexpected generated assets: ${unexpected.join(", ")}`);
  must(mismatched.length === 0, `Mismatched generated assets: ${mismatched.join(", ")}`);
  return `${expected.size} committed outputs exactly match the read-only in-memory build`;
});

check("icons/native-containers", async () => {
  const macosIconset = [
    ["marshal-app-icon-16.png", 16],
    ["marshal-app-icon-16@2x.png", 32],
    ["marshal-app-icon-32.png", 32],
    ["marshal-app-icon-32@2x.png", 64],
    ["marshal-app-icon-128.png", 128],
    ["marshal-app-icon-128@2x.png", 256],
    ["marshal-app-icon-256.png", 256],
    ["marshal-app-icon-256@2x.png", 512],
    ["marshal-app-icon-512.png", 512],
    ["marshal-app-icon-512@2x.png", 1024],
  ];
  requireRgbaPng("public/marshal-app-icon.png", 256, 256);
  requireRgbaPng("public/marshal-tray-template.png", 24, 24);
  requireRgbaPng("public/marshal-tray-template@2x.png", 48, 48);
  for (const [file, size] of macosIconset) {
    requireRgbaPng(`public/macos-iconset/${file}`, size, size);
  }
  for (const channel of ["dev", "beta"]) {
    requireRgbaPng(`public/marshal-app-icon-${channel}.png`, 256, 256);
    requireRgbaPng(`public/marshal-app-icon-${channel}-win.png`, 256, 256);
    requireRgbaPng(`public/marshal-app-icon-${channel}-overlay.png`, 16, 16);
    requireRgbaPng(`public/marshal-tray-template-${channel}.png`, 24, 24);
    requireRgbaPng(`public/marshal-tray-template-${channel}@2x.png`, 48, 48);
    requireRgbaPng(`public/marshal-tray-icon-${channel}.png`, 32, 32);
  }

  const ico = parseIcoEntries(readBytes("public/marshal-app-icon.ico"));
  const icoSizes = ico.map(({ width, height }) => {
    must(
      width === height,
      `public/marshal-app-icon.ico contains non-square ${width}x${height} frame`,
    );
    return width;
  });
  must(icoSizes.join(",") === "16,32,48,64,128,256", `unexpected ICO frames: ${icoSizes}`);
  for (const entry of ico) {
    must(entry.planes === 1 && entry.bitDepth === 32, `ICO ${entry.width}px frame is not 32-bit`);
    requireRgbaPngBuffer(
      entry.data,
      `public/marshal-app-icon.ico ${entry.width}px`,
      entry.width,
      entry.height,
    );
  }

  const expectedIcns = new Map([
    ["ic11", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic13", 256],
    ["ic08", 256],
    ["ic14", 512],
    ["ic09", 512],
    ["ic10", 1024],
  ]);
  const icns = parseIcnsEntries(readBytes("public/marshal-app-icon.icns")).entries;
  must(
    icns.length === expectedIcns.size,
    `marshal-app-icon.icns has ${icns.length} unexpected entries`,
  );
  for (const entry of icns) {
    const size = expectedIcns.get(entry.type);
    must(size, `marshal-app-icon.icns contains unexpected ${entry.type} entry`);
    requireRgbaPngBuffer(entry.data, `public/marshal-app-icon.icns ${entry.type}`, size, size);
  }

  return "PNG modes/dimensions plus ICO/ICNS frame metadata decoded successfully";
});

check("assets/no-legacy-mascot", () => {
  must(
    !existsSync(absolute("public/marshal-mascot.png")),
    "unused public/marshal-mascot.png is still copied into runtime output",
  );
  return "legacy mascot is not shipped";
});

// ------------------------------------------------------------------- report

for (const { id, fn } of checks) {
  try {
    const detail = await fn();
    results.push({ id, ok: true, detail: detail ?? "" });
  } catch (error) {
    results.push({ id, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

const width = Math.max(...results.map((r) => r.id.length));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(width)}  ${r.detail}`);
}
const failed = results.filter((r) => !r.ok);
console.log("");
console.log(
  failed.length === 0
    ? `VERDICT: PASS  (${results.length}/${results.length} visual-identity checks)`
    : `VERDICT: FAIL  (${failed.length} of ${results.length} checks failed)`,
);
process.exit(failed.length === 0 ? 0 : 1);
