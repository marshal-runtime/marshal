export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Stage transform: translate(x, y) scale(scale), origin top-left. */
export interface View extends Point {
  scale: number;
}

export const MAX_SCALE = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Scale that fits the diagram's width inside the viewport, never enlarging it. */
export function fitWidthScale(content: Size, viewportWidth: number, pad: number): number {
  if (content.width <= 0 || viewportWidth <= 0) return 1;
  return clamp((viewportWidth - pad * 2) / content.width, 0.02, 1);
}

/** Scale that fits the whole diagram inside the viewport, never enlarging it. */
export function containScale(content: Size, viewport: Size, pad: number): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  return clamp(
    Math.min(
      (viewport.width - pad * 2) / content.width,
      (viewport.height - pad * 2) / content.height,
    ),
    0.02,
    1,
  );
}

export function minScale(content: Size, viewport: Size, pad: number): number {
  return Math.min(
    fitWidthScale(content, viewport.width, pad),
    containScale(content, viewport, pad),
  );
}

/**
 * Keeps the diagram reachable: an axis that fits is centered; an axis that
 * overflows can pan only until its far edge meets the padding.
 */
export function clampView(view: View, content: Size, viewport: Size, pad: number): View {
  const width = content.width * view.scale;
  const height = content.height * view.scale;
  const x =
    width + pad * 2 <= viewport.width
      ? (viewport.width - width) / 2
      : clamp(view.x, viewport.width - pad - width, pad);
  const y =
    height + pad * 2 <= viewport.height
      ? (viewport.height - height) / 2
      : clamp(view.y, viewport.height - pad - height, pad);
  return { scale: view.scale, x, y };
}

/** Fit to width, top-aligned: the default and "reset" view. */
export function fitWidthView(content: Size, viewport: Size, pad: number): View {
  const scale = fitWidthScale(content, viewport.width, pad);
  return clampView({ scale, x: pad, y: pad }, content, viewport, pad);
}

/** Zooms to `nextScale` while keeping the content point under `anchor` fixed. */
export function zoomAt(view: View, nextScale: number, anchor: Point): View {
  const ratio = nextScale / view.scale;
  return {
    scale: nextScale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

/** Two-finger gesture: scales by the change in finger distance around the moving midpoint. */
export function pinchView(
  start: View,
  startPoints: [Point, Point],
  points: [Point, Point],
  bounds: { min: number; max: number },
): View {
  const distance = (pair: [Point, Point]) =>
    Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) || 1;
  const midpoint = (pair: [Point, Point]) => ({
    x: (pair[0].x + pair[1].x) / 2,
    y: (pair[0].y + pair[1].y) / 2,
  });
  const scale = clamp(
    (start.scale * distance(points)) / distance(startPoints),
    bounds.min,
    bounds.max,
  );
  const from = midpoint(startPoints);
  const to = midpoint(points);
  const contentX = (from.x - start.x) / start.scale;
  const contentY = (from.y - start.y) / start.scale;
  return { scale, x: to.x - contentX * scale, y: to.y - contentY * scale };
}

export function clampScale(scale: number, min: number): number {
  return clamp(scale, min, MAX_SCALE);
}
