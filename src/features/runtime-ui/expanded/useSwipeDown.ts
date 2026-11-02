import { useRef, useState, type PointerEvent } from "react";

const DISMISS_DISTANCE_PX = 110;
const DISMISS_VELOCITY_PX_PER_MS = 0.6;

/**
 * iOS-style pull-down: a touch drag on the handle moves the sheet with the
 * finger; releasing far or fast enough dismisses it, otherwise it springs back.
 * Mouse drags are ignored so desktop text selection keeps working.
 */
export function useSwipeDown(onDismiss: () => void) {
  const start = useRef<{ y: number; at: number; pointerId: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    start.current = { y: event.clientY, at: event.timeStamp, pointerId: event.pointerId };
    setDragging(true);
    // Touch pointers are captured to their target implicitly.
    if (event.pointerType !== "touch") event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const origin = start.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    setOffset(Math.max(0, event.clientY - origin.y));
  };
  const finish = (event: PointerEvent<HTMLElement>) => {
    const origin = start.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    start.current = null;
    setDragging(false);
    const distance = Math.max(0, event.clientY - origin.y);
    const velocity = distance / Math.max(1, event.timeStamp - origin.at);
    setOffset(0);
    if (distance > DISMISS_DISTANCE_PX || velocity > DISMISS_VELOCITY_PX_PER_MS) onDismiss();
  };

  return {
    offset,
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  };
}
