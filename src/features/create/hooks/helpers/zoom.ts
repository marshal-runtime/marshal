/** Browser-style preset levels; zoomIn/zoomOut step between adjacent presets. */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_ZOOM = 1;
export const MIN_ZOOM = ZOOM_LEVELS[0];
export const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

/** Tolerance (~0.1%) for float comparisons against zoom levels. */
export const ZOOM_EPSILON = 0.001;

export function normalizeZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function getAdjacentZoomLevel(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    const above = ZOOM_LEVELS.find((level) => level > current + ZOOM_EPSILON);
    return above ?? MAX_ZOOM;
  }
  let below: number | undefined;
  for (const level of ZOOM_LEVELS) {
    if (level < current - ZOOM_EPSILON) below = level;
    else break;
  }
  return below ?? MIN_ZOOM;
}
