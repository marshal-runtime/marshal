/**
 * Hook for drag-to-popout behavior on session list items.
 *
 * Uses HTML5 native drag-and-drop. A floating pill (rendered as a React portal)
 * follows the cursor; releasing past the nav's right edge opens the session in
 * a new window.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/marshal-class-names";

interface UseSessionDragOutOptions {
  /** `bounds` carries HTMLDragEvent.screenX/Y so the consumer can position the
   *  new window near where the user dropped. */
  onOpenInNewWindow?: (sessionId: string, bounds?: { x: number; y: number }) => void;
  sessionId: string;
  sessionName: string;
}

interface PillPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface UseSessionDragOutResult {
  isDragging: boolean;
  isOutside: boolean;
  dragProps: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent<HTMLElement>) => void;
    onDrag: (e: React.DragEvent<HTMLElement>) => void;
    onDragEnd: (e: React.DragEvent<HTMLElement>) => void;
  };
  dragPill: React.ReactNode;
}

function findNavBoundary(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>("[data-drag-boundary='nav']");
}

/** @internal Exported for testing. */
export function isOutsideNavRight(clientX: number, clientY: number, navRect: DOMRect): boolean {
  // No clamp to window width/height: dragging past the window edge into empty
  // desktop space is a valid drop. Vertical bounds still apply so a drag that
  // strays above/below the nav doesn't open a popout.
  return clientX > navRect.right && clientY >= navRect.top && clientY <= navRect.bottom;
}

export function useSessionDragOut({
  onOpenInNewWindow,
  sessionId,
  sessionName,
}: UseSessionDragOutOptions): UseSessionDragOutResult {
  const [isDragging, setIsDragging] = useState(false);
  const [isOutside, setIsOutside] = useState(false);
  const [pillPos, setPillPos] = useState<PillPosition | null>(null);

  const navRectRef = useRef<DOMRect | null>(null);
  // Chromium sometimes fires a final ondrag with (0,0) coords — track last
  // valid position so dragend can fall back to it.
  const lastValidPos = useRef({ x: 0, y: 0 });
  // ESC during a drag fires dragend with dropEffect="none". So does dropping
  // outside the window (no DOM target accepted the drop). Inspecting
  // dropEffect alone can't tell those apart, so we track ESC directly.
  const escPressedRef = useRef(false);

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (!onOpenInNewWindow) {
        e.preventDefault();
        return;
      }

      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input") ||
          target.closest("button") ||
          target.closest("[role='menu']") ||
          target.closest("[data-slot='dropdown-menu']"))
      ) {
        e.preventDefault();
        return;
      }

      const navEl = findNavBoundary(e.currentTarget);
      if (!navEl) {
        e.preventDefault();
        return;
      }

      navRectRef.current = navEl.getBoundingClientRect();
      const itemRect = e.currentTarget.getBoundingClientRect();

      // Suppress the default drag image with a transparent 1×1 ghost;
      // we render our own pill via portal so it can animate opacity.
      const ghost = document.createElement("div");
      ghost.style.opacity = "0";
      ghost.style.position = "fixed";
      ghost.style.top = "-9999px";
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 0, 0);
      setTimeout(() => ghost.remove(), 0);

      e.dataTransfer.effectAllowed = "move";

      setIsDragging(true);
      setPillPos({
        x: e.clientX + 14,
        y: e.clientY - 16,
        w: itemRect.width,
        h: itemRect.height,
      });
      lastValidPos.current = { x: e.clientX, y: e.clientY };
      escPressedRef.current = false;
    },
    [onOpenInNewWindow],
  );

  const onDrag = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (e.clientX === 0 && e.clientY === 0) return;

    lastValidPos.current = { x: e.clientX, y: e.clientY };
    const navRect = navRectRef.current;
    if (navRect) {
      setIsOutside(isOutsideNavRight(e.clientX, e.clientY, navRect));
    }
    setPillPos((prev) => (prev ? { ...prev, x: e.clientX + 14, y: e.clientY - 16 } : null));
  }, []);

  const resetDragState = useCallback(() => {
    setIsDragging(false);
    setIsOutside(false);
    setPillPos(null);
    navRectRef.current = null;
  }, []);

  const onDragEnd = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      const navRect = navRectRef.current;
      const pos =
        e.clientX === 0 && e.clientY === 0 ? lastValidPos.current : { x: e.clientX, y: e.clientY };

      if (
        navRect &&
        isOutsideNavRight(pos.x, pos.y, navRect) &&
        onOpenInNewWindow &&
        !escPressedRef.current
      ) {
        // HTML5 DnD provides screenX/Y natively. When the final event has zeroed
        // coords, screenX/Y are also zero — skip bounds rather than land the new
        // window in the top-left of the primary display.
        const hasScreenCoords = e.screenX !== 0 || e.screenY !== 0;
        onOpenInNewWindow(sessionId, hasScreenCoords ? { x: e.screenX, y: e.screenY } : undefined);
      }

      resetDragState();
    },
    [onOpenInNewWindow, sessionId, resetDragState],
  );

  // While dragging, listen for ESC at the document level (the drag-source
  // element may not have focus) AND keep a dragend safety net for the case
  // where the source element is unmounted mid-drag and the React handler
  // never fires. We deliberately do NOT also listen for `drop` — App.tsx
  // preventDefault's dragover globally to suppress Electron's file-drop
  // navigation, which makes `drop` fire for every release; a document `drop`
  // listener would zap navRectRef before the React dragend handler reads it.
  useEffect(() => {
    if (!isDragging) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") escPressedRef.current = true;
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("dragend", resetDragState);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("dragend", resetDragState);
    };
  }, [isDragging, resetDragState]);

  const dragPill =
    isDragging && pillPos
      ? createPortal(
          <div
            // aria-hidden because the row itself is the accessible name source —
            // without this, screen readers announce the session name twice
            // during drag.
            aria-hidden="true"
            style={{ left: pillPos.x, top: pillPos.y, width: pillPos.w, height: pillPos.h }}
            className={cn(
              // z-9999 layers above shadcn Radix portals (tooltip / dropdown at
              // z-50). Without this, the row tooltip — which doesn't dismiss
              // instantly when the user starts a drag, and re-arms as the
              // cursor passes over other rows mid-drag — paints over the pill.
              // Tailwind v4 accepts `z-9999` as a dynamic utility value.
              "pointer-events-none fixed z-9999 flex items-center truncate rounded-xl border border-border bg-accent px-3 text-sm text-foreground shadow-lg transition-opacity duration-150",
              isOutside ? "opacity-90" : "opacity-45",
            )}
          >
            {sessionName}
          </div>,
          document.body,
        )
      : null;

  return {
    isDragging,
    isOutside,
    dragProps: {
      draggable: !!onOpenInNewWindow,
      onDragStart,
      onDrag,
      onDragEnd,
    },
    dragPill,
  };
}
