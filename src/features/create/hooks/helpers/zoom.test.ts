import { describe, expect, it } from "vitest";

import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_EPSILON,
  ZOOM_LEVELS,
  getAdjacentZoomLevel,
  normalizeZoom,
} from "./zoom";

describe("normalizeZoom", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back for non-finite value %s",
    (value) => {
      expect(normalizeZoom(value)).toBe(DEFAULT_ZOOM);
    },
  );

  it.each([
    [MIN_ZOOM - 1, MIN_ZOOM],
    [MAX_ZOOM + 1, MAX_ZOOM],
    [MIN_ZOOM, MIN_ZOOM],
    [MAX_ZOOM, MAX_ZOOM],
    [1.25, 1.25],
  ])("clamps or preserves %s as %s", (value, expected) => {
    expect(normalizeZoom(value)).toBe(expected);
  });
});

describe("getAdjacentZoomLevel", () => {
  it("steps upward and downward through exact levels", () => {
    expect(getAdjacentZoomLevel(1, 1)).toBe(1.1);
    expect(getAdjacentZoomLevel(1, -1)).toBe(0.9);
  });

  it("steps past epsilon-adjacent levels", () => {
    expect(getAdjacentZoomLevel(1.1 - ZOOM_EPSILON / 2, 1)).toBe(1.25);
    expect(getAdjacentZoomLevel(1.1 + ZOOM_EPSILON / 2, -1)).toBe(1);
  });

  it("clamps at the upper and lower boundaries", () => {
    expect(getAdjacentZoomLevel(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(getAdjacentZoomLevel(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it("handles values outside the preset range", () => {
    expect(getAdjacentZoomLevel(MAX_ZOOM + 1, -1)).toBe(MAX_ZOOM);
    expect(getAdjacentZoomLevel(MIN_ZOOM - 1, 1)).toBe(MIN_ZOOM);
  });

  it("covers every exact preset level", () => {
    for (let index = 1; index < ZOOM_LEVELS.length - 1; index++) {
      expect(getAdjacentZoomLevel(ZOOM_LEVELS[index], 1)).toBe(ZOOM_LEVELS[index + 1]);
      expect(getAdjacentZoomLevel(ZOOM_LEVELS[index], -1)).toBe(ZOOM_LEVELS[index - 1]);
    }
  });
});
