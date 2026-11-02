import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

/**
 * Pointer handlers that call `onLongPress` after a steady press (or on a
 * context-menu gesture) and `onTap` for a short one. A press that turns into
 * a scroll is neither.
 */
export function useLongPress(onLongPress: () => void, onTap: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    start.current = null;
  };
  return {
    onPointerDown: (event: PointerEvent) => {
      // Keeps a menu trigger from opening on a plain tap.
      event.preventDefault();
      fired.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        start.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent) => {
      if (!start.current) return;
      const moved = Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y);
      if (moved > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: () => {
      const tapped = start.current !== null && !fired.current;
      cancel();
      if (tapped) onTap();
    },
    onPointerCancel: cancel,
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      cancel();
      fired.current = true;
      onLongPress();
    },
  };
}
