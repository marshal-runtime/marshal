import { describe, expect, it } from "vitest";

import { clampView, fitWidthView, minScale, pinchView, zoomAt } from "./pan-zoom";

const tall = { width: 2557, height: 9808 };
const viewport = { width: 740, height: 560 };
const pad = 16;

describe("pan-zoom", () => {
  it("fits a wide diagram to the viewport width, top-aligned", () => {
    const view = fitWidthView(tall, viewport, pad);
    expect(tall.width * view.scale).toBeCloseTo(viewport.width - pad * 2);
    expect(view.x).toBeCloseTo(pad);
    expect(view.y).toBe(pad);
  });

  it("never enlarges a small diagram past its natural size, and centers it", () => {
    const view = fitWidthView({ width: 300, height: 100 }, viewport, pad);
    expect(view.scale).toBe(1);
    expect(view.x).toBe((viewport.width - 300) / 2);
    expect(view.y).toBe((viewport.height - 100) / 2);
  });

  it("stops panning once the far edge reaches the padding", () => {
    const fitted = fitWidthView(tall, viewport, pad);
    const height = tall.height * fitted.scale;
    const pastBottom = clampView({ ...fitted, y: -100_000 }, tall, viewport, pad);
    expect(pastBottom.y).toBeCloseTo(viewport.height - pad - height);
    const pastTop = clampView({ ...fitted, y: 5_000 }, tall, viewport, pad);
    expect(pastTop.y).toBe(pad);
  });

  it("can zoom out far enough to show the whole diagram", () => {
    const lowest = minScale(tall, viewport, pad);
    expect(tall.height * lowest).toBeLessThanOrEqual(viewport.height - pad * 2 + 0.001);
  });

  it("keeps the point under the cursor fixed while zooming", () => {
    const start = { scale: 0.5, x: 20, y: -300 };
    const anchor = { x: 200, y: 150 };
    const before = { x: (anchor.x - start.x) / start.scale, y: (anchor.y - start.y) / start.scale };
    const next = zoomAt(start, 1.5, anchor);
    expect((anchor.x - next.x) / next.scale).toBeCloseTo(before.x);
    expect((anchor.y - next.y) / next.scale).toBeCloseTo(before.y);
  });

  it("pinches around the moving midpoint and respects the scale bounds", () => {
    const start = { scale: 1, x: 0, y: 0 };
    const from: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ];
    const spread = pinchView(
      start,
      from,
      [
        { x: 50, y: 100 },
        { x: 250, y: 100 },
      ],
      {
        min: 0.5,
        max: 4,
      },
    );
    expect(spread.scale).toBe(2);
    expect(spread.x).toBe(-150);
    const huge = pinchView(
      start,
      from,
      [
        { x: 0, y: 100 },
        { x: 5000, y: 100 },
      ],
      {
        min: 0.5,
        max: 4,
      },
    );
    expect(huge.scale).toBe(4);
  });
});
