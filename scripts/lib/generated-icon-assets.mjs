import { promises as fs } from "node:fs";
import path from "node:path";

import sharp from "sharp";

import { badgeTextSvg, measureBadgeTextEm, validateBadgeGlyphResources } from "./badge-glyphs.mjs";
import { buffersToIco, parseIcoEntries } from "./ico.mjs";
import { buffersToIcns, parseIcnsEntries } from "./marshal-icns.mjs";

const APP_ICON_SIZE = 256;
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const CHANNELS = ["dev", "beta"];
const MACOS_ICONSET_FILES = [
  { file: "marshal-app-icon-16.png", size: 16 },
  { file: "marshal-app-icon-16@2x.png", size: 32 },
  { file: "marshal-app-icon-32.png", size: 32 },
  { file: "marshal-app-icon-32@2x.png", size: 64 },
  { file: "marshal-app-icon-128.png", size: 128 },
  { file: "marshal-app-icon-128@2x.png", size: 256 },
  { file: "marshal-app-icon-256.png", size: 256 },
  { file: "marshal-app-icon-256@2x.png", size: 512 },
  { file: "marshal-app-icon-512.png", size: 512 },
  { file: "marshal-app-icon-512@2x.png", size: 1024 },
];
const ICNS_SOURCES = [
  { type: "ic11", size: 32, file: "marshal-app-icon-16@2x.png" },
  { type: "ic12", size: 64, file: "marshal-app-icon-32@2x.png" },
  { type: "ic07", size: 128, file: "marshal-app-icon-128.png" },
  { type: "ic13", size: 256, file: "marshal-app-icon-128@2x.png" },
  { type: "ic08", size: 256, file: "marshal-app-icon-256.png" },
  { type: "ic14", size: 512, file: "marshal-app-icon-256@2x.png" },
  { type: "ic09", size: 512, file: "marshal-app-icon-512.png" },
  { type: "ic10", size: 1024, file: "marshal-app-icon-512@2x.png" },
];

const DEV_COLOR = "#e67e22";
const BETA_COLOR = "#3498db";
const MODE_BADGE = {
  dev: { label: "DEV", color: DEV_COLOR, overlay: "D" },
  beta: { label: "BETA", color: BETA_COLOR, overlay: "B" },
};

export const GENERATED_ICON_PATHS = Object.freeze([
  "public/marshal-app-icon.png",
  ...MACOS_ICONSET_FILES.map(({ file }) => `public/macos-iconset/${file}`),
  "public/marshal-app-icon.ico",
  "public/marshal-tray-template.png",
  "public/marshal-tray-template@2x.png",
  ...CHANNELS.map((mode) => `public/marshal-app-icon-${mode}.png`),
  ...CHANNELS.flatMap((mode) => [
    `public/marshal-tray-template-${mode}.png`,
    `public/marshal-tray-template-${mode}@2x.png`,
  ]),
  ...CHANNELS.map((mode) => `public/marshal-tray-icon-${mode}.png`),
  ...CHANNELS.map((mode) => `public/marshal-app-icon-${mode}-win.png`),
  ...CHANNELS.map((mode) => `public/marshal-app-icon-${mode}-overlay.png`),
  "public/marshal-app-icon.icns",
]);

function sourcePath(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

async function renderSvg(root, relativePath, size) {
  return sharp(sourcePath(root, relativePath), { density: 384 })
    .resize(size, size, { fit: "contain" })
    .png()
    .toBuffer();
}

function fitPill(text, canvasSize, { fontRatio, pillHRatio, marginRatio, sidePadEm = 0.55 }) {
  const margin = Math.round(canvasSize * marginRatio);
  const maxPillW = canvasSize - 2 * margin;
  let fontSize = Math.round(canvasSize * fontRatio);
  const textWidthEm = measureBadgeTextEm(text);
  const pillWFor = (size) => Math.round(size * (textWidthEm + 2 * sidePadEm));
  let pillW = pillWFor(fontSize);
  if (pillW > maxPillW) {
    fontSize = Math.floor(maxPillW / (textWidthEm + 2 * sidePadEm));
    pillW = Math.min(pillWFor(fontSize), maxPillW);
  }
  let pillH = Math.round(canvasSize * pillHRatio);
  pillH = Math.max(pillH, Math.round(fontSize * 1.35));
  return { fontSize, pillW, pillH, margin };
}

function badgeSvg(text, bgColor, canvasSize) {
  const { fontSize, pillW, pillH, margin } = fitPill(text, canvasSize, {
    fontRatio: 0.18,
    pillHRatio: 0.22,
    marginRatio: 0.02,
  });
  const rx = Math.round(pillH / 2);
  const strokeW = Math.max(1, Math.round(canvasSize * 0.02));
  const x = Math.max(margin, canvasSize - pillW - margin);
  const y = canvasSize - pillH - margin;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}">
  <rect x="${x}" y="${y}" width="${pillW}" height="${pillH}" rx="${rx}" fill="${bgColor}" stroke="white" stroke-width="${strokeW}"/>
  ${badgeTextSvg(text, { centerX: x + pillW / 2, centerY: y + pillH / 2, fontSize })}
</svg>`);
}

function templateBadgeSvg(text, color, canvasSize, { sidePadEm = 0.55, pillHRatio = 0.44 } = {}) {
  const { fontSize, pillW, pillH, margin } = fitPill(text, canvasSize, {
    fontRatio: 0.3,
    pillHRatio,
    marginRatio: 0.04,
    sidePadEm,
  });
  const strokeW = Math.max(1, Math.round(pillH * 0.09));
  const rx = Math.round(pillH / 2);
  const x = Math.max(Math.ceil(strokeW / 2), canvasSize - pillW - margin);
  const y = canvasSize - pillH - Math.round(canvasSize * 0.02);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}">
  <rect x="${x}" y="${y}" width="${pillW}" height="${pillH}" rx="${rx}" fill="${color}" stroke="white" stroke-width="${strokeW}"/>
  ${badgeTextSvg(text, { centerX: x + pillW / 2, centerY: y + pillH / 2, fontSize })}
</svg>`);
}

function overlaySvg(letter, bgColor, size) {
  const fontSize = Math.round(size * 0.65);
  const radius = size / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <circle cx="${radius}" cy="${radius}" r="${radius - 1}" fill="${bgColor}" stroke="white" stroke-width="2"/>
  ${badgeTextSvg(letter, { centerX: radius, centerY: radius, fontSize })}
</svg>`);
}

async function composite(base, overlay) {
  return sharp(base)
    .composite([{ input: overlay, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

function setAsset(assets, relativePath, buffer) {
  if (assets.has(relativePath)) throw new Error(`Duplicate generated asset: ${relativePath}`);
  assets.set(relativePath, buffer);
}

function manifestDiff(assets) {
  const expected = new Set(GENERATED_ICON_PATHS);
  return {
    missing: GENERATED_ICON_PATHS.filter((relativePath) => !assets.has(relativePath)),
    extra: [...assets.keys()].filter((relativePath) => !expected.has(relativePath)),
  };
}

export function assertGeneratedIconManifest(assets) {
  const { missing, extra } = manifestDiff(assets);
  if (missing.length || extra.length) {
    throw new Error(
      `Generated icon manifest mismatch. Missing: ${missing.join(", ") || "none"}; ` +
        `extra: ${extra.join(", ") || "none"}.`,
    );
  }
}

async function validatePng(assets, relativePath, width, height) {
  const buffer = assets.get(relativePath);
  if (!buffer) throw new Error(`Missing generated PNG: ${relativePath}`);
  const meta = await sharp(buffer).metadata();
  if (
    meta.format !== "png" ||
    meta.width !== width ||
    meta.height !== height ||
    meta.channels !== 4 ||
    !meta.hasAlpha ||
    meta.depth !== "uchar"
  ) {
    throw new Error(
      `${relativePath} must be ${width}x${height} 32-bit RGBA PNG; got ` +
        `${meta.width}x${meta.height} ${meta.format}/${meta.channels ?? "?"}ch/${meta.depth ?? "?"}.`,
    );
  }
}

async function validateWhiteAlpha(assets, relativePath) {
  const buffer = assets.get(relativePath);
  if (!buffer) throw new Error(`Missing generated template: ${relativePath}`);
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let visible = 0;
  let colored = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset + 3] === 0) continue;
    visible++;
    if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255) {
      colored++;
    }
  }
  if (visible === 0 || colored > 0) {
    throw new Error(
      `${relativePath} must be true white+alpha; visible=${visible}, colored=${colored}.`,
    );
  }
}

async function validateIco(assets) {
  const entries = parseIcoEntries(assets.get("public/marshal-app-icon.ico"));
  const sizes = entries.map(({ width, height }) => {
    if (width !== height)
      throw new Error(`marshal-app-icon.ico has non-square ${width}x${height} frame`);
    return width;
  });
  if (sizes.join(",") !== ICO_SIZES.join(",")) {
    throw new Error(
      `marshal-app-icon.ico frames are ${sizes.join(",")}; expected ${ICO_SIZES.join(",")}`,
    );
  }
  for (const entry of entries) {
    if (entry.planes !== 1 || entry.bitDepth !== 32) {
      throw new Error(`marshal-app-icon.ico ${entry.width}px frame is not 1-plane/32-bit.`);
    }
    const meta = await sharp(entry.data).metadata();
    if (
      meta.format !== "png" ||
      meta.width !== entry.width ||
      meta.height !== entry.height ||
      meta.channels !== 4 ||
      !meta.hasAlpha
    ) {
      throw new Error(
        `marshal-app-icon.ico ${entry.width}px frame is not a 32-bit RGBA PNG payload.`,
      );
    }
  }
}

async function validateIcns(assets) {
  const { entries } = parseIcnsEntries(assets.get("public/marshal-app-icon.icns"));
  const expected = new Map(ICNS_SOURCES.map(({ type, size }) => [type, size]));
  if (entries.length !== expected.size) {
    throw new Error(
      `marshal-app-icon.icns contains ${entries.length} entries; expected ${expected.size}.`,
    );
  }
  for (const { type, data } of entries) {
    const size = expected.get(type);
    if (!size) throw new Error(`marshal-app-icon.icns contains unexpected entry ${type}.`);
    const meta = await sharp(data).metadata();
    if (
      meta.format !== "png" ||
      meta.width !== size ||
      meta.height !== size ||
      meta.channels !== 4 ||
      !meta.hasAlpha
    ) {
      throw new Error(
        `marshal-app-icon.icns ${type} must contain a ${size}x${size} 32-bit RGBA PNG.`,
      );
    }
  }
}

export async function validateGeneratedIconAssetMap(assets) {
  assertGeneratedIconManifest(assets);
  await validatePng(assets, "public/marshal-app-icon.png", APP_ICON_SIZE, APP_ICON_SIZE);
  for (const { file, size } of MACOS_ICONSET_FILES) {
    await validatePng(assets, `public/macos-iconset/${file}`, size, size);
  }
  for (const mode of CHANNELS) {
    await validatePng(assets, `public/marshal-app-icon-${mode}.png`, 256, 256);
    await validatePng(assets, `public/marshal-app-icon-${mode}-win.png`, 256, 256);
    await validatePng(assets, `public/marshal-app-icon-${mode}-overlay.png`, 16, 16);
    await validatePng(assets, `public/marshal-tray-template-${mode}.png`, 24, 24);
    await validatePng(assets, `public/marshal-tray-template-${mode}@2x.png`, 48, 48);
    await validatePng(assets, `public/marshal-tray-icon-${mode}.png`, 32, 32);
  }
  await validatePng(assets, "public/marshal-tray-template.png", 24, 24);
  await validatePng(assets, "public/marshal-tray-template@2x.png", 48, 48);
  await validateWhiteAlpha(assets, "public/marshal-tray-template.png");
  await validateWhiteAlpha(assets, "public/marshal-tray-template@2x.png");
  await validateIco(assets);
  await validateIcns(assets);
}

export async function buildGeneratedIconAssets(root) {
  validateBadgeGlyphResources(root);
  const assets = new Map();

  const releaseIcon = await renderSvg(root, "public/marshal-app-icon.svg", APP_ICON_SIZE);
  setAsset(assets, "public/marshal-app-icon.png", releaseIcon);
  for (const { file, size } of MACOS_ICONSET_FILES) {
    setAsset(
      assets,
      `public/macos-iconset/${file}`,
      await renderSvg(root, "public/marshal-app-icon.svg", size),
    );
  }

  const icoFrames = [];
  for (const size of ICO_SIZES) {
    icoFrames.push({ size, data: await renderSvg(root, "public/marshal-app-icon.svg", size) });
  }
  const ico = buffersToIco(icoFrames);
  setAsset(assets, "public/marshal-app-icon.ico", ico);

  const template24 = await renderSvg(root, "public/marshal-icon-outline.svg", 24);
  const template48 = await renderSvg(root, "public/marshal-icon-outline.svg", 48);
  setAsset(assets, "public/marshal-tray-template.png", template24);
  setAsset(assets, "public/marshal-tray-template@2x.png", template48);

  for (const mode of CHANNELS) {
    const { label, color } = MODE_BADGE[mode];
    setAsset(
      assets,
      `public/marshal-app-icon-${mode}.png`,
      await composite(releaseIcon, badgeSvg(label, color, 256)),
    );
  }

  for (const mode of CHANNELS) {
    const { label, color } = MODE_BADGE[mode];
    setAsset(
      assets,
      `public/marshal-tray-template-${mode}.png`,
      await composite(template24, templateBadgeSvg(label, color, 24)),
    );
    setAsset(
      assets,
      `public/marshal-tray-template-${mode}@2x.png`,
      await composite(template48, templateBadgeSvg(label, color, 48)),
    );
  }

  const release32 = await renderSvg(root, "public/marshal-app-icon.svg", 32);
  for (const mode of CHANNELS) {
    const { label, color } = MODE_BADGE[mode];
    setAsset(
      assets,
      `public/marshal-tray-icon-${mode}.png`,
      await composite(release32, templateBadgeSvg(label, color, 32)),
    );
  }

  for (const mode of CHANNELS) {
    const { label, color } = MODE_BADGE[mode];
    setAsset(
      assets,
      `public/marshal-app-icon-${mode}-win.png`,
      await composite(releaseIcon, templateBadgeSvg(label, color, 256)),
    );
  }

  for (const mode of CHANNELS) {
    const { overlay, color } = MODE_BADGE[mode];
    setAsset(
      assets,
      `public/marshal-app-icon-${mode}-overlay.png`,
      await sharp(overlaySvg(overlay, color, 16))
        .png()
        .toBuffer(),
    );
  }

  const icnsEntries = ICNS_SOURCES.map(({ type, file }) => ({
    type,
    data: assets.get(`public/macos-iconset/${file}`),
  }));
  setAsset(assets, "public/marshal-app-icon.icns", buffersToIcns(icnsEntries));

  await validateGeneratedIconAssetMap(assets);
  return assets;
}

export async function writeGeneratedIconAssets(root, assets) {
  assertGeneratedIconManifest(assets);
  for (const relativePath of GENERATED_ICON_PATHS) {
    const target = sourcePath(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, assets.get(relativePath));
  }
}
