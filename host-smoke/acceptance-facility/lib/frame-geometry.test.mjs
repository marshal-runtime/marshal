import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFrameGeometryExpression } from "./frame-geometry.mjs";

void test("buildFrameGeometryExpression embeds the surface and title as JSON-encoded literals", () => {
  const expression = buildFrameGeometryExpression({
    surface: "panel",
    expectedTitle: "Sample App",
  });
  assert.match(expression, /"panel"/);
  assert.match(expression, /"Sample App"/);
  assert.match(expression, /data-runtime-ui-surface/);
  assert.match(expression, /runtime-ui-packaged-frame/);
});

void test("buildFrameGeometryExpression tolerates a surface value containing quotes without breaking the expression", () => {
  const expression = buildFrameGeometryExpression({
    surface: 'tab"; alert(1); "',
    expectedTitle: null,
  });
  // JSON.stringify escapes the embedded quote so it stays a single string literal, not executable syntax.
  assert.match(expression, /\\"/);
});

void test("buildFrameGeometryExpression allows an absent expectedTitle", () => {
  const expression = buildFrameGeometryExpression({ surface: "inline-card" });
  assert.match(expression, /null/);
});
