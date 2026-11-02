import { useCallback, useEffect, useState } from "react";

/**
 * Shared hook for custom context menus in the co-create editor.
 *
 * **Why not Radix `ContextMenu`?** Radix's portal-based menu conflicts with
 * Electron's native `context-menu` IPC event, causing crashes when both fire
 * on right-click. This hook sets `window.__customContextMenuActive = true`
 * synchronously during the `contextmenu` event, which is the guard that
 * prevents the native menu from firing (checked in `electron/main.ts`).
 *
 * The menu auto-closes on outside click, scroll, or Escape.
 */
export interface CtxMenuPosition {
  x: number;
  y: number;
}

const MENU_WIDTH = 180;
const MENU_HEIGHT_ESTIMATE = 200;

/** Clamp coordinates so the menu stays within the viewport. */
function clampToViewport(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(x, window.innerWidth - MENU_WIDTH),
    y: Math.min(y, window.innerHeight - MENU_HEIGHT_ESTIMATE),
  };
}

export function useCreateContextMenu() {
  const [menu, setMenu] = useState<CtxMenuPosition | null>(null);

  // Close on outside click, scroll, or Escape
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => {
      setMenu(null);
      window.__customContextMenuActive = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
      window.__customContextMenuActive = false;
    };
  }, [menu]);

  const open = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(clampToViewport(e.clientX, e.clientY));
    window.__customContextMenuActive = true;
  }, []);

  const close = useCallback(() => {
    setMenu(null);
    window.__customContextMenuActive = false;
  }, []);

  /** Run an action and close the menu. Useful for menu item onClick handlers. */
  const closeAndRun = useCallback(
    (fn: () => void) => () => {
      close();
      fn();
    },
    [close],
  );

  return { menu, open, close, closeAndRun } as const;
}
