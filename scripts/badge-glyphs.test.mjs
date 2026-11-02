import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BADGE_FONT_SOURCE,
  badgeTextSvg,
  validateBadgeGlyphResources,
} from "./lib/badge-glyphs.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const temps = [];

test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

test("bundled Geist source and deterministic badge paths are available", () => {
  const result = validateBadgeGlyphResources(repoRoot);
  assert.equal(result.source, BADGE_FONT_SOURCE);
  for (const label of ["DEV", "BETA", "D", "B"]) {
    const svg = badgeTextSvg(label, { centerX: 50, centerY: 20, fontSize: 16 });
    assert.match(svg, /<path /);
    assert.doesNotMatch(svg, /<text|font-family/);
  }
});

test("missing bundled badge font source fails closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "marshal-badge-font-"));
  temps.push(root);
  mkdirSync(path.join(root, "public", "fonts"), { recursive: true });
  assert.throws(() => validateBadgeGlyphResources(root), /Missing deterministic badge font source/);
});
