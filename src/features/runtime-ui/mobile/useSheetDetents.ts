import { useRef, useState, type CSSProperties, type PointerEvent } from "react";

export type SheetDetent = "strip" | "half" | "full";

const ORDER: readonly SheetDetent[] = ["strip", "half", "full"];
const FRACTION: Record<SheetDetent, number> = { strip: 0, half: 0.55, full: 0.88 };
const TAP_SLOP_PX = 6;
const FLICK_PX_PER_MS = 0.5;

function visibleHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * iOS sheet detents: drag the grabber and the sheet follows the finger, then
 * settles on the nearest stop (a flick moves one stop in its direction). A tap
 * toggles between the strip and half height.
 */
export function useSheetDetents() {
  const [detent, setDetent] = useState<SheetDetent>("strip");
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{
    readonly pointerId: number;
    readonly y: number;
    readonly at: number;
    readonly height: number;
    readonly minHeight: number;
  } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const sheet = event.currentTarget.closest("[data-phone-sheet]");
    if (!(sheet instanceof HTMLElement)) return;
    const strip = sheet.querySelector("[data-phone-sheet-strip]");
    drag.current = {
      pointerId: event.pointerId,
      y: event.clientY,
      at: event.timeStamp,
      height: sheet.getBoundingClientRect().height,
      minHeight: strip instanceof HTMLElement ? strip.getBoundingClientRect().height : 48,
    };
    // Touch pointers are captured to their target implicitly.
    if (event.pointerType !== "touch") event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const origin = drag.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const moved = origin.y - event.clientY;
    if (dragHeight === null && Math.abs(moved) < TAP_SLOP_PX) return;
    const max = visibleHeight() * 0.92;
    setDragHeight(Math.min(max, Math.max(origin.minHeight, origin.height + moved)));
  };
  const finish = (event: PointerEvent<HTMLElement>) => {
    const origin = drag.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    drag.current = null;
    const moved = origin.y - event.clientY;
    setDragHeight(null);
    if (Math.abs(moved) < TAP_SLOP_PX) {
      setDetent((current) => (current === "strip" ? "half" : "strip"));
      return;
    }
    const velocity = moved / Math.max(1, event.timeStamp - origin.at);
    const index = ORDER.indexOf(detent);
    if (Math.abs(velocity) > FLICK_PX_PER_MS) {
      const next = index + (velocity > 0 ? 1 : -1);
      setDetent(ORDER[Math.min(ORDER.length - 1, Math.max(0, next))]);
      return;
    }
    const fraction = (origin.height + moved) / visibleHeight();
    const nearest = ORDER.reduce((best, stop) =>
      Math.abs(FRACTION[stop] - fraction) < Math.abs(FRACTION[best] - fraction) ? stop : best,
    );
    setDetent(nearest);
  };

  const style: CSSProperties | undefined =
    dragHeight !== null
      ? { height: dragHeight }
      : detent === "strip"
        ? undefined
        : // Sized to the visible area: the phone keyboard shrinks it, not dvh.
          { height: `calc(var(--remote-height, 100dvh) * ${FRACTION[detent]})` };

  return {
    detent,
    setDetent,
    dragging: dragHeight !== null,
    style,
    grabber: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  };
}
